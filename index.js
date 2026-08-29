const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;

const DATA_FILE = path.join(__dirname, 'database.json');
const SENHA_MESTRA = "minhasenha123";

// Função para carregar dados salvos (Memória Persistente)
function carregarBanco() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const arquivo = fs.readFileSync(DATA_FILE, 'utf8');
      const dados = JSON.parse(arquivo);
      return {
        usuariosAutenticados: new Set(dados.usuarios || []),
        historicoConversas: new Map(Object.entries(dados.historicos || {}))
      };
    } catch (e) {
      console.error("Erro ao ler o banco de dados, criando novo:", e);
    }
  }
  return { usuariosAutenticados: new Set(), historicoConversas: new Map() };
}

// Função para salvar dados no arquivo local
function salvarBanco() {
  try {
    const dados = {
      usuarios: Array.from(banco.usuariosAutenticados),
      historicos: Object.fromEntries(banco.historicoConversas)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2));
  } catch (e) {
    console.error("Erro ao salvar o banco de dados:", e);
  }
}

const banco = carregarBanco();

async function enviarMensagemTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

app.post('/webhook', async (req, res) => {
  try {
    console.log("Mensagem recebida do Telegram:", JSON.stringify(req.body));
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id.toString(); // Garantir que seja string para a Map
    const text = message.text;

    // 1. Verificação de senha por usuário com salvamento automático
    if (!banco.usuariosAutenticados.has(chatId)) {
      if (text === SENHA_MESTRA) {
        banco.usuariosAutenticados.add(chatId);
        salvarBanco();
        await enviarMensagemTelegram(chatId, "Senha correta! Acesso autorizado e salvo com sucesso. Como posso te ajudar?");
      } else {
        await enviarMensagemTelegram(chatId, "🔒 Olá! Este bot é protegido. Por favor, digite a senha de acesso para continuar:");
      }
      return res.sendStatus(200);
    }

    // 2. Gerenciamento do histórico por usuário (Memória de Curto e Longo Prazo)
    if (!banco.historicoConversas.has(chatId)) {
      banco.historicoConversas.set(chatId, []);
    }
    const historico = banco.historicoConversas.get(chatId);

    historico.push({ role: "user", content: text });

    if (historico.length > 15) {
      historico.shift(); // Mantém as últimas 15 mensagens
    }

    // 3. Chamada para a API do OpenRouter com modelo atualizado
    const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001", // Modelo ativo no OpenRouter
        messages: historico
      })
    });

    const data = await openRouterRes.json();
    console.log("Resposta completa do OpenRouter:", JSON.stringify(data));

    let replyText = "Desculpe, ocorreu um erro ao gerar a resposta.";

    if (data.choices && data.choices[0]?.message?.content) {
      replyText = data.choices[0].message.content;
      historico.push({ role: "assistant", content: replyText });
      salvarBanco(); // Salva o histórico atualizado no arquivo
    } else if (data.error) {
      replyText = `Erro do OpenRouter: ${data.error.message}`;
    }

    // Envia a resposta de volta para o Telegram
    await enviarMensagemTelegram(chatId, replyText);

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro crítico no processamento:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('Bot Telegram com Memória Persistente rodando com sucesso!');
});

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  if (TELEGRAM_TOKEN) {
    const webhookUrl = `https://telegram-gemini-bot-pmyx.onrender.com/webhook`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
    console.log(`Webhook configurado para: ${webhookUrl}`);
  }
});
