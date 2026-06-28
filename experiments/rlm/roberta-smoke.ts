import { pipeline } from '@huggingface/transformers'

async function main() {
  const t0 = performance.now()
  const clf = await pipeline('text-classification', 'nicky48/emotion-english-distilroberta-base-ONNX', { dtype: 'q8' })
  console.log(`model loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  const t1 = performance.now()
  const out = (await clf(['i love you so much', 'i am so done with this', 'where are the keys'], { top_k: 7 })) as unknown
  console.log(`inferred 3 in ${((performance.now() - t1) / 1000).toFixed(2)}s`)
  console.log(JSON.stringify(out, null, 0).slice(0, 600))
}
main().catch((e) => { console.error('ROBERTA SMOKE ERR:', e?.message ?? e); process.exit(1) })
