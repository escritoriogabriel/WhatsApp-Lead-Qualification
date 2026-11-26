const schema = {
  type: 'object',
  properties: { capturedFields: { type: 'object', properties: {
    nome: { type: 'string' }, assunto: { type: 'string' }, cidade: { type: 'string' }, prazo: { type: 'string' },
  }, additionalProperties: false } },
  required: ['capturedFields'], additionalProperties: false,
};
const cases = [
  { text: 'Meu nome é Ana. Quero saber sobre demissão. Moro em Recife.', expected: { nome: 'Ana', assunto: 'demissão', cidade: 'Recife' } },
  { text: 'A empresa não pagou meu salário de outubro. Sou Carlos, de Manaus.', expected: { nome: 'Carlos', assunto: 'salário de outubro', cidade: 'Manaus' } },
  { text: 'Tenho uma audiência em 12 de dezembro em Curitiba. Meu nome é João.', expected: { nome: 'João', assunto: 'audiência', cidade: 'Curitiba', prazo: '12 de dezembro' } },
  { text: 'Quero conversar com um advogado, ainda não sei explicar o caso.', expected: {} },
];
const system = 'Extraia somente fatos explícitos nos campos permitidos. Use apenas mensagens da pessoa como evidência. Cada valor deve ser trecho literal de uma mensagem recebida; não infira, complete ou resuma fatos. Se não houver dado informado, omita o campo. Não dê orientação jurídica. Retorne apenas JSON no schema fornecido.';
const evaluate = (actual, expected) => {
  const fields = actual && typeof actual === 'object' && !Array.isArray(actual) ? actual : {};
  const missing = Object.entries(expected).filter(([key, value]) => !String(fields[key] ?? '').toLocaleLowerCase('pt-BR').includes(value.toLocaleLowerCase('pt-BR'))).map(([key]) => key);
  const unexpected = Object.entries(fields).filter(([key, value]) => !(key in expected) && String(value ?? '').trim()).map(([key]) => key);
  return { ok: missing.length === 0 && unexpected.length === 0, missingFields: missing, unexpectedFields: unexpected };
};

async function runOllama(model) {
  const rows = [];
  for (const item of cases) {
    const start = performance.now();
    try {
      const response = await fetch(`${process.env.OLLAMA_API_URL ?? 'http://localhost:11434'}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, format: schema, options: { temperature: 0 }, messages: [
          { role: 'system', content: system }, { role: 'user', content: JSON.stringify({ camposPermitidos: ['nome','assunto','cidade','prazo'], conversa: item.text }) },
        ] }), signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const parsed = JSON.parse(result.message.content);
      rows.push({ ...evaluate(parsed.capturedFields, item.expected), invalidJson: false, ms: Math.round(performance.now()-start), fields: parsed.capturedFields ?? {}, evalTokensPerSecond: result.eval_duration ? Math.round(result.eval_count/(result.eval_duration/1e9)) : null });
    } catch (error) { rows.push({ ok: false, missingFields: Object.keys(item.expected), unexpectedFields: [], invalidJson: error instanceof SyntaxError, ms: Math.round(performance.now()-start), error: error.message }); }
  }
  let loadedBytes = null;
  try { const ps = await fetch(`${process.env.OLLAMA_API_URL ?? 'http://localhost:11434'}/api/ps`).then((r)=>r.json()); loadedBytes = ps.models?.find((m)=>m.name===model || m.model===model)?.size ?? null; } catch {}
  return { model, rows, loadedBytes };
}

async function runGemini(model) {
  const rows=[];
  for(const item of cases){
    const start=performance.now();
    try{
      const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:JSON.stringify({camposPermitidos:['nome','assunto','cidade','prazo'],conversa:item.text})}]}],generationConfig:{temperature:0,responseMimeType:'application/json',responseJsonSchema:schema}}),signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json();const content=data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';const parsed=JSON.parse(content);
      rows.push({...evaluate(parsed.capturedFields,item.expected),invalidJson:false,ms:Math.round(performance.now()-start),fields:parsed.capturedFields??{}});
    }catch(error){rows.push({ok:false,missingFields:Object.keys(item.expected),unexpectedFields:[],invalidJson:error instanceof SyntaxError,ms:Math.round(performance.now()-start),error:error.message});}
  }
  return {model:`gemini:${model}`,rows,loadedBytes:null};
}

const models = (process.env.BENCHMARK_MODELS ?? 'qwen3:0.6b,gemma3:1b').split(',').map((value) => value.trim()).filter(Boolean);
const results = [];
for (const model of models) results.push(await runOllama(model));
if(process.env.GEMINI_API_KEY)results.push(await runGemini(process.env.GEMINI_MODEL??'gemini-3.5-flash-lite'));
for (const result of results) {
  const valid = result.rows.filter((row) => row.ok).length;
  const times = result.rows.map((row) => row.ms).sort((a,b)=>a-b);
  console.log(JSON.stringify({ model: result.model, correctCases: `${valid}/${cases.length}`, invalidJsonCases: result.rows.filter((row) => row.invalidJson).length, unexpectedFieldCases: result.rows.filter((row) => row.unexpectedFields?.length).length, medianLatencyMs: times[Math.floor(times.length/2)], loadedModelBytes:result.loadedBytes, rows: result.rows }));
}
if(!process.env.GEMINI_API_KEY)console.log('Gemini: não executado; GEMINI_API_KEY não está disponível no ambiente.');
