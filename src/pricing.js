export const pricingVersion='2026-08-06'

const rates=[
  [/^gpt-5\.6-sol$|^gpt-5\.6$/, {provider:'OpenAI',input:5,cached:0.5,output:30}],
  [/^gpt-5\.6-terra$/, {provider:'OpenAI',input:2.5,cached:0.25,output:15}],
  [/^gpt-5\.6-luna$/, {provider:'OpenAI',input:1,cached:0.1,output:6}],
  [/^gpt-5\.3-codex$/, {provider:'OpenAI',input:1.75,cached:0.175,output:14}],
  [/claude.*opus/i, {provider:'Anthropic',input:15,cached:1.5,output:75}],
  [/claude.*sonnet/i, {provider:'Anthropic',input:3,cached:0.3,output:15}],
  [/claude.*3[.-]?5.*haiku|claude.*haiku.*3[.-]?5/i, {provider:'Anthropic',input:0.8,cached:0.08,output:4}],
  [/claude.*haiku/i, {provider:'Anthropic',input:0.25,cached:0.03,output:1.25}]
]

export function estimateTokenCost(model,usage={}){
  const match=rates.find(([pattern])=>pattern.test(String(model||'')))
  if(!match)return null
  const rate=match[1],input=Math.max(0,Number(usage.input_tokens)||0),cached=Math.min(input,Math.max(0,Number(usage.cached_tokens)||0)),output=Math.max(0,Number(usage.output_tokens)||0)
  return{amount:((input-cached)*rate.input+cached*rate.cached+output*rate.output)/1e6,currency:'USD',basis:'api_equivalent',provider:rate.provider,model,pricing_version:pricingVersion,rates_per_million:{input:rate.input,cached_input:rate.cached,output:rate.output}}
}
