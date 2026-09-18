"use strict";

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOB_VERSION = "3.1.0";
const DATA_DIR = path.join(__dirname, "data_bob");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.log");

if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}

function now() {
  return new Date().toISOString();
}

function id(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function safeString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

async function saveJSON(file, data) {
  try {
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error(`Erro ao salvar ${file}:`, error.message);
  }
}

async function loadJSON(file, fallback) {
  try {
    if (!fsSync.existsSync(file)) return fallback;
    const content = await fs.readFile(file, "utf8");
    if (!content.trim()) return fallback;
    return JSON.parse(content);
  } catch (error) {
    console.error(`Erro ao carregar ${file}:`, error.message);
    return fallback;
  }
}

class Memory {
  constructor() {
    this.data = { users: {}, global: { facts: [], lessons: [] }, blockedUsers: [] };
  }

  async init() {
    this.data = await loadJSON(MEMORY_FILE, this.data);
    if (!this.data.blockedUsers) this.data.blockedUsers = [];
  }

  ensureUser(userId) {
    if (!this.data.users[userId]) {
      this.data.users[userId] = {
        identity: { userId, createdAt: now() },
        preferences: {},
        conversations: [],
        projects: [],
        tasks: [],
        facts: [],
        lessons: []
      };
      this.save();
    }
    return this.data.users[userId];
  }

  getUser(userId) {
    return this.ensureUser(userId);
  }

  async addConversation(userId, role, content) {
    const user = this.ensureUser(userId);
    user.conversations.push({ id: id("msg"), role, content, timestamp: now() });
    if (user.conversations.length > 200) {
      user.conversations = user.conversations.slice(-200);
    }
    await this.save();
  }

  async addFact(userId, fact) {
    const user = this.ensureUser(userId);
    user.facts.push({ id: id("fact"), text: fact, createdAt: now() });
    await this.save();
  }

  async addLesson(userId, lesson) {
    const user = this.ensureUser(userId);
    user.lessons.push({ id: id("lesson"), text: lesson, createdAt: now() });
    await this.save();
  }

  getContext(userId) {
    const user = this.ensureUser(userId);
    return {
      identity: user.identity,
      preferences: user.preferences,
      facts: user.facts.slice(-20),
      lessons: user.lessons.slice(-20),
      projects: user.projects,
      recentConversation: user.conversations.slice(-20)
    };
  }

  async deleteUserMemory(userId) {
    delete this.data.users[userId];
    await this.save();
  }

  async blockUser(userId) {
    if (!this.data.blockedUsers.includes(userId)) {
      this.data.blockedUsers.push(userId);
      await this.save();
    }
  }

  async unblockUser(userId) {
    this.data.blockedUsers = this.data.blockedUsers.filter(u => u !== userId);
    await this.save();
  }

  isBlocked(userId) {
    return this.data.blockedUsers.includes(userId);
  }

  async save() {
    await saveJSON(MEMORY_FILE, this.data);
  }
}

class Identity {
  constructor(memory) {
    this.memory = memory;
    this.users = new Map();
    this.masterId = null;
  }

  register(userId) {
    if (!userId) throw new Error("ID do usuário é obrigatório.");
    const user = this.memory.getUser(userId);
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        userId,
        role: this.masterId === userId ? "MASTER" : "USER",
        active: true,
        createdAt: user.identity.createdAt
      });
    }
    return this.users.get(userId);
  }

  setMaster(userId) {
    if (!userId) throw new Error("MASTER_ID não informado.");
    this.masterId = userId;
    const account = this.register(userId);
    account.role = "MASTER";
    return account;
  }

  get(userId) {
    return this.register(userId);
  }

  isMaster(userId) {
    return Boolean(this.masterId && this.masterId === userId);
  }
}

class Security {
  constructor(identity, memory) {
    this.identity = identity;
    this.memory = memory;
  }

  authorize(userId, action) {
    const isMaster = this.identity.isMaster(userId);

    if (isMaster) {
      return { allowed: true, reason: "Acesso total concedido (Obediência Absoluta ao MASTER)." };
    }

    const account = this.identity.get(userId);
    if (!account.active) {
      return { allowed: false, reason: "Usuário desativado." };
    }

    if (this.memory.isBlocked(userId)) {
      return { allowed: false, reason: "Usuário bloqueado." };
    }

    if (action === "admin") {
      return { allowed: false, reason: "Permissão MASTER necessária." };
    }

    return { allowed: true, reason: "Autorizado." };
  }
}

class Audit {
  async log(event) {
    const record = { timestamp: now(), ...event };
    try {
      await fs.appendFile(AUDIT_FILE, JSON.stringify(record) + "\n", "utf8");
    } catch (error) {
      console.error("Erro no Log de Auditoria:", error.message);
    }
  }
}

class Planner {
  createPlan(message, isMaster = false) {
    const text = safeString(message).toLowerCase();
    const steps = [];

    if (!text) return { objective: "", complexity: "low", steps: [], isMasterCommand: isMaster };

    if (text.includes("pesquise") || text.includes("pesquisar") || text.includes("procure") || text.includes("internet")) steps.push("pesquisa");
    if (text.includes("código") || text.includes("codigo") || text.includes("programar") || text.includes("javascript") || text.includes("python") || text.includes("erro")) steps.push("programacao");
    if (text.includes("explique") || text.includes("ensine") || text.includes("aprender") || text.includes("como funciona")) steps.push("ensino");
    if (text.includes("segurança") || text.includes("seguranca") || text.includes("senha") || text.includes("hack")) steps.push("seguranca");
    if (text.includes("analise") || text.includes("análise") || text.includes("compare") || text.includes("avaliar")) steps.push("analise");
    if (text.includes("escreva") || text.includes("texto") || text.includes("email") || text.includes("mensagem")) steps.push("escrita");

    if (steps.length === 0) steps.push("conversa");

    return {
      objective: message,
      complexity: isMaster ? "high_priority" : steps.length > 1 ? "medium" : "low",
      steps,
      isMasterCommand: isMaster
    };
  }
}

class Agent {
  constructor(name, description, keywords, handler = null) {
    this.name = name;
    this.description = description;
    this.keywords = keywords;
    this.customHandler = handler;
  }

  canHandle(text) {
    const lower = safeString(text).toLowerCase();
    return this.keywords.some(keyword => lower.includes(keyword));
  }

  async execute(context) {
    if (this.customHandler) {
      return await this.customHandler(context);
    }
    return {
      agent: this.name,
      status: "success",
      message: `Agente ${this.name} executado com sucesso.`,
      context
    };
  }
}

class Agents {
  constructor() {
    this.list = [
      new Agent("PROGRAMADOR", "Programação e debugging.", ["código", "codigo", "programar", "javascript", "python", "bug", "erro"]),
      new Agent("PESQUISADOR", "Pesquisa de informações.", ["pesquise", "pesquisar", "procure", "internet", "fonte"]),
      new Agent("PROFESSOR", "Ensino e explicação.", ["explique", "ensine", "aprender", "estudar", "como funciona"]),
      new Agent("SEGURANÇA", "Segurança e proteção.", ["segurança", "seguranca", "senha", "autenticação", "hack"]),
      new Agent("ANALISTA", "Análise e comparação.", ["analise", "análise", "compare", "comparar", "avaliar"]),
      new Agent("ESCRITOR", "Produção de textos.", ["escreva", "texto", "email", "mensagem", "documento"]),
      new Agent("ADMINISTRADOR", "Administração do sistema.", ["usuário", "usuario", "administrador", "configuração", "configuracao"])
    ];
  }

  select(message) {
    const matches = this.list.filter(agent => agent.canHandle(message));
    return matches.length > 0 ? matches : [this.list.find(agent => agent.name === "ANALISTA")];
  }
}

class Tools {
  constructor() {
    this.registry = new Map();
    this.register("hora", async () => ({ result: new Date().toLocaleString("pt-BR") }));
    this.register("sistema", async () => ({
      platform: process.platform,
      node: process.version,
      memory: process.memoryUsage()
    }));
  }

  register(name, handler) {
    this.registry.set(name, handler);
  }

  async execute(name, args = {}) {
    if (!this.registry.has(name)) throw new Error(`Ferramenta inexistente: ${name}`);
    return await this.registry.get(name)(args);
  }
}

class Verifier {
  verify(result, isMaster = false) {
    if (isMaster) return { valid: true, reason: "Aprovado via Master Override." };
    if (!result) return { valid: false, reason: "Resultado vazio." };
    if (result.status === "error") return { valid: false, reason: "Agente retornou erro." };
    return { valid: true, reason: "Resultado válido." };
  }
}

class Learning {
  constructor(memory) {
    this.memory = memory;
  }

  async learn(userId, message, result) {
    if (message && result) {
      await this.memory.addLesson(userId, `Interação processada em ${now()}`);
    }
  }
}

class Orchestrator {
  constructor({ agents, verifier, audit }) {
    this.agents = agents;
    this.verifier = verifier;
    this.audit = audit;
  }

  async execute({ userId, message, plan, context, isMaster }) {
    const selected = this.agents.select(message);
    const results = [];

    for (const agent of selected) {
      await this.audit.log({ type: "agent_selected", userId, agent: agent.name, isMaster });
      try {
        const result = await agent.execute({ userId, message, plan, context, isMaster });
        const verification = this.verifier.verify(result, isMaster);
        results.push({ agent: agent.name, result, verification });
      } catch (error) {
        results.push({
          agent: agent.name,
          result: null,
          verification: { valid: false, reason: error.message }
        });
      }
    }
    return results;
  }
}

class BobBrain {
  constructor(aiProvider = null) {
    this.aiProvider = aiProvider;
    this.initialized = false;
  }

  async init() {
    console.log(`🧠 Inicializando Bob Brain ${BOB_VERSION}...`);
    this.memory = new Memory();
    await this.memory.init();

    this.identity = new Identity(this.memory);
    this.security = new Security(this.identity, this.memory);
    this.audit = new Audit();
    this.planner = new Planner();
    this.agents = new Agents();
    this.tools = new Tools();
    this.verifier = new Verifier();
    this.learning = new Learning(this.memory);
    this.orchestrator = new Orchestrator({
      agents: this.agents,
      verifier: this.verifier,
      audit: this.audit
    });

    this.initialized = true;
    console.log("✅ Bob Brain totalmente carregado e pronto.");
  }

  setAIProvider(fn) {
    this.aiProvider = fn;
  }

  async setMaster(userId) {
    if (!this.initialized) await this.init();
    const result = this.identity.setMaster(userId);
    await this.audit.log({ type: "master_defined", userId });
    return result;
  }

  isMaster(userId) {
    return this.identity.isMaster(userId);
  }

  async process({ userId, message, extraContext = "" }) {
    if (!this.initialized) await this.init();

    userId = safeString(userId);
    message = safeString(message);

    if (!userId) throw new Error("userId é obrigatório.");
    if (!message) return { success: false, response: "Não recebi nenhuma mensagem." };

    const isMaster = this.identity.isMaster(userId);
    const identity = this.identity.get(userId);

    const authorization = this.security.authorize(userId, "chat");
    if (!authorization.allowed) {
      await this.audit.log({ type: "access_denied", userId, reason: authorization.reason });
      return { success: false, response: "Acesso negado.", reason: authorization.reason };
    }

    const context = this.memory.getContext(userId);
    await this.memory.addConversation(userId, "user", message);

    const plan = this.planner.createPlan(message, isMaster);
    const results = await this.orchestrator.execute({ userId, message, plan, context, isMaster });
    const validResults = results.filter(item => item.verification.valid);

    await this.learning.learn(userId, message, results);

    let response;
    if (this.aiProvider) {
      const mensagens = [
        { role: "system", content: `Você é o Bob IA, um assistente inteligente e amigável conversando com ${identity.userId}. Responde sempre em português, de forma clara e útil.${extraContext ? `\nContexto adicional: ${extraContext}` : ""}` },
        ...context.recentConversation.map(c => ({ role: c.role, content: c.content })),
        { role: "user", content: message }
      ];
      response = await this.aiProvider(mensagens);
    } else {
      response = this.composeResponse({ identity, plan, results, isMaster });
    }

    await this.memory.addConversation(userId, "assistant", response);
    await this.audit.log({
      type: "interaction",
      userId,
      isMaster,
      plan,
      agents: results.map(item => item.agent),
      validResults: validResults.length
    });

    return {
      success: true,
      userId,
      isMaster,
      identity,
      plan,
      agents: results.map(item => item.agent),
      response
    };
  }

  composeResponse({ identity, plan, results, isMaster }) {
    const agents = results.map(item => item.agent).join(", ");
    const failed = results.filter(item => !item.verification.valid);

    let masterBadge = isMaster ? "👑 [ORDEM DO MASTER EXECUTADA]\n" : "";

    if (failed.length > 0 && !isMaster) {
      return [
        `🧠 Bob Brain ${BOB_VERSION}`,
        "",
        `👤 Usuário: ${identity.userId}`,
        `🎯 Objetivo: ${plan.objective}`,
        `🤖 Agente(s): ${agents}`,
        "",
        "⚠️ A execução precisa de uma etapa adicional de correção/verificação."
      ].join("\n");
    }

    return [
      `${masterBadge}🧠 Bob Brain ${BOB_VERSION}`,
      "",
      `👤 Usuário: ${identity.userId}`,
      `🎯 Objetivo: ${plan.objective}`,
      `📋 Complexidade: ${plan.complexity}`,
      `🤖 Agente(s): ${agents}`,
      "",
      "✅ Solicitação processada com sucesso pelo núcleo do Bob."
    ].join("\n");
  }

  async admin(userId, action, targetUserId) {
    if (!this.initialized) await this.init();

    const auth = this.security.authorize(userId, "admin");
    if (!auth.allowed) {
      return { success: false, error: auth.reason };
    }

    switch (action) {
      case "block":
        await this.memory.blockUser(targetUserId);
        await this.audit.log({ type: "user_blocked", by: userId, target: targetUserId });
        return { success: true, action: "block" };

      case "unblock":
        await this.memory.unblockUser(targetUserId);
        await this.audit.log({ type: "user_unblocked", by: userId, target: targetUserId });
        return { success: true, action: "unblock" };

      case "delete_memory":
        await this.memory.deleteUserMemory(targetUserId);
        await this.audit.log({ type: "memory_deleted", by: userId, target: targetUserId });
        return { success: true, action: "delete_memory" };

      default:
        return { success: false, error: "Ação administrativa desconhecida." };
    }
  }

  status() {
    return {
      name: "BOB AI X",
      version: BOB_VERSION,
      brain: "ONLINE",
      masterDefined: Boolean(this.identity && this.identity.masterId),
      agents: this.agents ? this.agents.list.map(a => a.name) : []
    };
  }
}

module.exports = BobBrain;
