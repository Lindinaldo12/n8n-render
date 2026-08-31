const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY;

const DATA_FILE = path.join(__dirname, 'database.json');
const SENHA_MESTRA = "minhasenha123";

process.on('uncaughtException', (err) => {
  console.error('ERRO NÃO TRATADO (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('REJEIÇÃO NÃO TRATADA (unhandledRejection):', reason);
});

// 🧠 Sistema de Memória Permanente e Evolutiva
function carregarBanco() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const arquivo = fs.readFileSync(DATA_FILE, 'utf8');
      const dados = JSON.parse(arquivo);
      if (!dados.perfisUsuarios) dados.perfisUsuarios = {};
      if (!dados.historicoConversas) dados.historicoConversas = {};
      return dados;
    } catch (e) {
      console.error('Erro ao carregar banco:', e);
    }
  }
  return {
    perfisUsuarios: {},
    historicoConversas: {}
  };
}

function salvarBanco() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(banco, null, 2));
  } catch (e) {
    console.error('Erro ao salvar banco:', e);
  }
}

const banco = carregarBanco();

async function enviarMensagemTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  } catch (e) {
    console.error("Erro ao enviar mensagem para o Telegram:", e);
  }
}

async function configurarWebhook() {
  const webhookUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/webhook`
    : `https://telegram-gemini-bot-pmyx.onrender.com/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const data = await res.json();
    console.log("Webhook configurado para:", webhookUrl);
    console.log("Resposta do Telegram:", JSON.stringify(data));
  } catch (e) {
    console.error("Erro ao configurar webhook:", e);
  }
}

app.post('/webhook', async (req, res) => {
  try {
    console.log("Mensagem recebida do Telegram:", JSON.stringify(req.body));
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id.toString();
    const text = message.text;
    const userInfo = message.from || {};

    // Criar perfil se não existir
    if (!banco.perfisUsuarios[chatId]) {
      banco.perfisUsuarios[chatId] = {
        first_name: userInfo.first_name || "usuário",
        username: userInfo.username || "",
        language_code: userInfo.language_code || "pt-br",
        criadoEm: new Date().toISOString()
      };
      salvarBanco();
    }

    const perfil = banco.perfisUsuarios[chatId];

    // Inicializar histórico
    if (!banco.historicoConversas[chatId]) {
      banco.historicoConversas[chatId] = [];
    }

    const historico = banco.historicoConversas[chatId];

    const mensagensParaAPI = [
      {
        role: "system",
        content: `Você está conversando com ${perfil.first_name}.`
      },
      ...historico,
      { role: "user", content: text }
    ];

    historico.push({ role: "user", content: text });
    if (historico.length > 20) {
      historico.shift();
    }

    // 🤖 Chamada para a API do Grok (xAI)
    const iaRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "grok-4",
        messages: mensagensParaAPI
      })
    });

    const data = await iaRes.json();
    console.log("Resposta completa do Grok:", JSON.stringify(data));

    let resposta = "Desculpe, não consegui processar sua mensagem.";

    if (data.choices && data.choices[0] && data.choices[0].message) {
      resposta = data.choices[0].message.content;
    } else if (data.error) {
      resposta = `Erro: ${data.error.message || JSON.stringify(data.error)}`;
    }

    // Salvar resposta no histórico
    historico.push({ role: "assistant", content: resposta });
    if (historico.length > 20) {
      historico.shift();
    }
    salvarBanco();

    // Enviar resposta ao Telegram
    await enviarMensagemTelegram(chatId, resposta);

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => {
  res.send('Bot está rodando! 🤖');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  configurarWebhook();
});
