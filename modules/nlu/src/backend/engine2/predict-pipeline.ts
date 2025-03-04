import * as sdk from 'botpress/sdk'
import _ from 'lodash'

import { getClosestToken } from '../pipelines/language/ft_featurizer'
import LanguageIdentifierProvider, { NA_LANG } from '../pipelines/language/ft_lid'
import * as math from '../tools/math'
import { PatternEntity } from '../typings'

import CRFExtractor2 from './crf-extractor2'
import { Tools } from './engine2'
import { extractUtteranceEntities } from './entity-extractor'
import { Model } from './model-service'
import { EXACT_MATCH_STR_OPTIONS, ExactMatchIndex, Intent, TrainArtefacts } from './training-pipeline'
import Utterance, { buildUtterances } from './utterance'

export interface Predictors {
  ctx_classifer: sdk.MLToolkit.SVM.Predictor
  intent_classifier_per_ctx: _.Dictionary<sdk.MLToolkit.SVM.Predictor>
  kmeans: sdk.MLToolkit.KMeans.KmeansResult
  slot_tagger: CRFExtractor2 // TODO replace this by MlToolkit.CRF.Tagger
}

export interface PredictInput {
  defaultLanguage: string
  includedContexts: string[]
  sentence: string
}

export type PredictStep = TrainArtefacts & {
  readonly rawText: string
  includedContexts: string[]
  detectedLanguage: string
  languageCode: string
  intents: Intent<Utterance>[]
  pattern_entities: PatternEntity[]
  predictors: Predictors
  tools: Tools
  utterance?: Utterance
  ctx_predictions?: sdk.MLToolkit.SVM.Prediction[]
  intent_predictions?: {
    per_ctx?: _.Dictionary<sdk.MLToolkit.SVM.Prediction[]>
    combined?: E1IntentPred[] // only to comply with E1
    elected?: E1IntentPred // only to comply with E1
    ambiguous?: boolean
  }
  // TODO slots predictions per intent
}

export type PredictOutput = sdk.IO.EventUnderstanding // temporary fully compliant with engine1

// only to comply with E1
type E1IntentPred = {
  name: string
  context: string
  confidence: number
}

const DEFAULT_CTX = 'global'
const NONE_INTENT = 'none'

async function DetectLanguage(
  input: PredictInput,
  supportedLanguages: string[],
  tools: Tools
): Promise<{ detectedLanguage: string; usedLanguage: string }> {
  const langIdentifier = LanguageIdentifierProvider.getLanguageIdentifier(tools.mlToolkit)
  const lidRes = await langIdentifier.identify(input.sentence)
  const elected = lidRes.filter(pred => supportedLanguages.includes(pred.label))[0]

  // because with single-worded sentences, confidence is always very low
  // we assume that a input of 20 chars is more than a single word
  const threshold = input.sentence.length > 20 ? 0.5 : 0.3

  let detectedLanguage = _.get(elected, 'label', NA_LANG)
  if (detectedLanguage !== NA_LANG && !supportedLanguages.includes(detectedLanguage)) {
    detectedLanguage = NA_LANG
  }

  const usedLanguage =
    detectedLanguage !== NA_LANG && elected.value > threshold ? detectedLanguage : input.defaultLanguage

  return { usedLanguage, detectedLanguage }
}
async function preprocessInput(
  input: PredictInput,
  tools: Tools,
  modelsByLang: _.Dictionary<Model>,
  predictorsBylang: _.Dictionary<Predictors>
): Promise<PredictStep> {
  const { detectedLanguage, usedLanguage } = await DetectLanguage(input, Object.keys(modelsByLang), tools)
  const model = modelsByLang[usedLanguage]

  const intents = model.data.output!.intents

  return {
    ...model.data.artefacts,
    pattern_entities: model.data.input.pattern_entities,
    includedContexts: input.includedContexts,
    rawText: input.sentence,
    detectedLanguage,
    languageCode: usedLanguage,
    intents,
    predictors: predictorsBylang[usedLanguage],
    tools: tools
  }
}

async function makePredictionUtterance(input: PredictStep): Promise<PredictStep> {
  const [utterance] = await buildUtterances([input.rawText], input.languageCode, input.tools)

  const { tfidf, vocabVectors, predictors } = input
  utterance.tokens.forEach(token => {
    const t = token.toString({ lowerCase: true })
    if (!tfidf[t]) {
      const closestToken = getClosestToken(t, <number[]>token.vectors, vocabVectors)
      tfidf[t] = tfidf[closestToken]
    }
  })

  utterance.setGlobalTfidf(tfidf)
  utterance.setKmeans(predictors.kmeans)

  return {
    ...input,
    utterance
  }
}

async function extractEntities(input: PredictStep): Promise<PredictStep> {
  await extractUtteranceEntities(input.utterance!, input, input.tools)
  return { ...input }
}

async function predictContex(input: PredictStep): Promise<PredictStep> {
  if (input.intents.length === 0) {
    return { ...input, ctx_predictions: [{ label: DEFAULT_CTX, confidence: 1 }] }
  }

  const features = input.utterance.sentenceEmbedding
  const predictions = await input.predictors.ctx_classifer.predict(features)

  return {
    ...input,
    ctx_predictions: predictions
  }
}

async function predictIntent(input: PredictStep): Promise<PredictStep> {
  if (input.intents.length === 0) {
    return { ...input, intent_predictions: { per_ctx: { [DEFAULT_CTX]: [{ label: NONE_INTENT, confidence: 1 }] } } }
  }

  const ctxToPredict = input.ctx_predictions.map(p => p.label)
  const predictions = (await Promise.map(ctxToPredict, async ctx => {
    const predictor = input.predictors.intent_classifier_per_ctx[ctx]
    if (!predictor) {
      return
    }
    const features = [...input.utterance.sentenceEmbedding, input.utterance.tokens.length]
    const preds = await predictor.predict(features)
    const exactPred = findExactIntentForCtx(input.exact_match_index, input.utterance, ctx)
    if (exactPred) {
      preds.unshift(exactPred)
    }

    return preds
  })).filter(_.identity)

  return {
    ...input,
    intent_predictions: { per_ctx: _.zipObject(ctxToPredict, predictions) }
  }
}

// taken from svm classifier #295
// this means that the 3 best predictions are really close, do not change magic numbers
function predictionsReallyConfused(predictions: sdk.MLToolkit.SVM.Prediction[]): boolean {
  const intentsPreds = predictions.filter(x => x.label !== 'none')
  if (intentsPreds.length <= 2) {
    return false
  }

  const std = math.std(intentsPreds.map(p => p.confidence))
  const diff = (intentsPreds[0].confidence - intentsPreds[1].confidence) / std
  if (diff >= 2.5) {
    return false
  }

  const bestOf3STD = math.std(predictions.slice(0, 3).map(p => p.confidence))
  return bestOf3STD <= 0.03
}

// TODO implement this algorithm properly / improve it
// currently taken as is from svm classifier (engine 1) and does't make much sens
function electIntent(input: PredictStep): PredictStep {
  const totalConfidence = Math.min(1, _.sumBy(input.ctx_predictions, 'confidence'))
  const ctxPreds = input.ctx_predictions.map(x => ({ ...x, confidence: x.confidence / totalConfidence }))

  // taken from svm classifier #349
  const predictions = _.chain(ctxPreds)
    .flatMap(({ label: ctx, confidence: ctxConf }) => {
      const intentPreds = _.orderBy(input.intent_predictions.per_ctx[ctx], 'confidence', 'desc')
      if (intentPreds.length === 1 || intentPreds[0].confidence === 1) {
        return [{ label: intentPreds[0].label, l0Confidence: ctxConf, context: ctx, confidence: 1 }]
      }

      if (predictionsReallyConfused(intentPreds)) {
        const others = _.take(intentPreds, 4).map(x => ({
          label: x.label,
          l0Confidence: ctxConf,
          confidence: ctxConf * x.confidence,
          context: ctx
        }))
        return [{ label: 'none', l0Confidence: ctxConf, context: ctx, confidence: 1 }, ...others] // refine confidence
      }

      const lnstd = math.std(intentPreds.map(x => Math.log(x.confidence))) // because we want a lognormal distribution
      let p1Conf = math.GetZPercent((Math.log(intentPreds[0].confidence) - Math.log(intentPreds[1].confidence)) / lnstd)
      if (isNaN(p1Conf)) {
        p1Conf = 0.5
      }

      return [
        { label: intentPreds[0].label, l0Confidence: ctxConf, context: ctx, confidence: ctxConf * p1Conf },
        { label: intentPreds[1].label, l0Confidence: ctxConf, context: ctx, confidence: ctxConf * (1 - p1Conf) }
      ]
    })
    .orderBy('confidence', 'desc')
    .uniqBy(p => p.label)
    .map(p => ({ name: p.label, context: p.context, confidence: p.confidence }))
    .value()

  return _.merge(_.cloneDeep(input), {
    intent_predictions: { combined: predictions, elected: _.maxBy(predictions, 'confidence') }
  })
}

function detectAmbiguity(input: PredictStep): PredictStep {
  // +- 10% away from perfect median leads to ambiguity
  const preds = input.intent_predictions.combined
  const perfectConfusion = 1 / preds.length
  const low = perfectConfusion - 0.1
  const up = perfectConfusion + 0.1
  const confidenceVec = preds.map(p => p.confidence)

  const ambiguous = preds.length > 1 && math.allInRange(confidenceVec, low, up)

  return _.merge(_.cloneDeep(input), { intent_predictions: { ambiguous } })
}

async function extractSlots(input: PredictStep): Promise<PredictStep> {
  const intent =
    !input.intent_predictions.ambiguous && input.intents.find(i => i.name === input.intent_predictions.elected.name)
  if (intent && intent.slot_definitions.length > 0) {
    // TODO try to extract for each intent predictions and then rank this in the election step
    const slots = await input.predictors.slot_tagger.extract(input.utterance, intent)
    slots.forEach(({ slot, start, end }) => {
      input.utterance.tagSlot(slot, start, end)
    })
  }

  return { ...input }
}

function MapStepToOutput(step: PredictStep, startTime: number): PredictOutput {
  const entities = step.utterance.entities.map(
    e =>
      ({
        name: e.type,
        type: e.metadata.entityId,
        data: {
          unit: e.metadata.unit,
          value: e.value
        },
        meta: {
          confidence: e.confidence,
          end: e.endPos,
          source: e.metadata.source,
          start: e.startPos
        }
      } as sdk.NLU.Entity)
  )

  const slots = step.utterance.slots.reduce(
    (slots, s) => {
      return {
        ...slots,
        [s.name]: {
          confidence: s.confidence,
          name: s.name,
          source: s.source,
          value: s.source // TODO replace by value once added in the slot
          // TODO add entity ?
        } as sdk.NLU.Slot
      }
    },
    {} as sdk.NLU.SlotCollection
  )
  return {
    ambiguous: step.intent_predictions.ambiguous,
    detectedLanguage: step.detectedLanguage,
    entities,
    errored: false,
    includedContexts: step.includedContexts,
    intent: step.intent_predictions.elected,
    intents: step.intent_predictions.combined,
    language: step.languageCode,
    slots,
    ms: Date.now() - startTime
  }
}

// TODO move this in exact match module
export function findExactIntentForCtx(
  exactMatchIndex: ExactMatchIndex,
  utterance: Utterance,
  ctx: string
): sdk.MLToolkit.SVM.Prediction | undefined {
  // TODO add some levinstein logic here
  const candidateKey = utterance.toString(EXACT_MATCH_STR_OPTIONS)

  const maybeMatch = exactMatchIndex[candidateKey]
  if (_.get(maybeMatch, 'contexts', []).includes(ctx)) {
    return { label: maybeMatch.intent, confidence: 1 }
  }
}

export const Predict = async (
  input: PredictInput,
  tools: Tools,
  modelsByLang: _.Dictionary<Model>,
  predictorsByLang: _.Dictionary<Predictors>
): Promise<PredictOutput> => {
  try {
    const t0 = Date.now()
    let stepOutput = await preprocessInput(input, tools, modelsByLang, predictorsByLang)

    stepOutput = await makePredictionUtterance(stepOutput)
    stepOutput = await extractEntities(stepOutput)
    stepOutput = await predictContex(stepOutput)
    stepOutput = await predictIntent(stepOutput)
    stepOutput = electIntent(stepOutput)
    stepOutput = detectAmbiguity(stepOutput)
    stepOutput = await extractSlots(stepOutput)
    return MapStepToOutput(stepOutput, t0)
  } catch (err) {
    console.log('Could not perform predict predict data', err)
    return { errored: true } as sdk.IO.EventUnderstanding
  }
}
