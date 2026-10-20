import { ProxyAgent, fetch as ufetch } from "undici";
const uri = process.argv[2];
try {
  const d = new ProxyAgent({ uri });
  const r = await ufetch("https://api.ipify.org", { dispatcher: d });
  console.log("OK", uri, "->", (await r.text()).trim());
  await d.close();
} catch (e) { console.log("FAIL", uri, "->", e.constructor.name, e.message.slice(0,90)); }
