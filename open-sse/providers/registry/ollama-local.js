export default {
  id: "ollama-local",
  priority: 50,
  hasFree: true,
  alias: "ollama-local",
  display: {
    name: "Ollama Local",
    icon: "cloud",
    color: "#ffffffff",
    textIcon: "OL",
    website: "https://ollama.com",
  },
  category: "apikey",
  transport: {
    baseUrl: "http://localhost:11434/api/chat",
    format: "ollama",
  },
  serviceKinds: ["llm", "systemone"],
  models: [
    { id: "clef", name: "System One clef (local)", kind: "systemone" },
    { id: "clef-flash", name: "System One clef-flash (local)", kind: "systemone" },
  ],
};
