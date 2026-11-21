import { agoraConfig } from '../config.js';
import { GREETING, SYSTEM_PROMPT } from '../agora/prompt.js';
import { createStore } from '../store/store.js';
import { runTool, tools } from '../tools/registry.js';

// Text-only dry run of a call against the real LLM and the real tool handlers.
// Lines starting with SPOKEN are exactly what Agora would send to Murf; everything else is internal.
// Usage: npm run chat:sim -- "March 14" "yes both" "I have a fever, no swelling, pain is 4"
// Uses the same LLM settings as the deployed agent, including LLM_EXTRA_PARAMS. Override for one run:
//   LLM_EXTRA_PARAMS='{}' npm run chat:sim
const turns = process.argv.slice(2);
if (!turns.length) turns.push('March 14', 'yes I picked them up and took today\'s dose', 'I have a fever, no swelling, pain is a 4');

const cfg = agoraConfig();
const store = createStore(':memory:', '/tmp/chat-sim-alerts.log');
store.createCall('sim', 'demo-001');
const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.params } }));
const messages: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'assistant', content: GREETING }];
console.log(`SPOKEN  agent: ${GREETING}`);

for (const turn of turns) {
  console.log(`\nUSER    ${turn}`);
  messages.push({ role: 'user', content: turn });
  for (let hop = 0; hop < 6; hop++) {
    // Streaming, like Agora: it speaks delta.content and (we suspect) ignores delta.reasoning_content.
    const res = await fetch(cfg.LLM_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.LLM_MODEL, messages, tools: toolDefs, stream: true, ...cfg.LLM_EXTRA_PARAMS }),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 300));
    const msg: any = { content: '', reasoning_content: '', tool_calls: [] as any[] };
    let buf = '';
    for await (const chunk of res.body as any) {
      buf += Buffer.from(chunk).toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        const d = JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {};
        msg.content += d.content ?? '';
        msg.reasoning_content += d.reasoning_content ?? '';
        for (const tc of d.tool_calls ?? []) {
          const cur = (msg.tool_calls[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          cur.id ||= tc.id ?? '';
          cur.function.name += tc.function?.name ?? '';
          cur.function.arguments += tc.function?.arguments ?? '';
        }
      }
    }
    if (!msg.tool_calls.length) delete msg.tool_calls;
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls, ...(msg.reasoning_content && { reasoning_content: msg.reasoning_content }) });
    if (msg.reasoning_content) console.log(`  think (reasoning_content, ${msg.reasoning_content.length} chars): ${msg.reasoning_content.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (msg.content) console.log(`SPOKEN  agent: ${msg.content}`);
    if (!msg.tool_calls?.length) break;
    for (const c of msg.tool_calls) {
      const tool = tools.find((t) => t.name === c.function.name)!;
      const out = runTool(store, tool, { call_id: 'sim', tool_call_id: c.id, ...JSON.parse(c.function.arguments) });
      console.log(`  tool  ${c.function.name}(${c.function.arguments}) -> ${JSON.stringify(out.body)}`);
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out.body) });
    }
  }
}
