const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Memórias em tempo de execução
const usuariosAutenticados = new Set();
const historicoConversas = new Map(); // Armazena o histórico de chat por usuário
const SENHA_MESTRA = "minhasenha123";

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

    const chatId = message.chat.id;
    const text = message.text;

    // 1. Verificação de senha
    if (!usuariosAutenticados.has(chatId)) {
      if (text === SENHA_MESTRA) {
        usuariosAutenticados.add(chatId);
        await enviarMensagemTelegram(chatId, "Senha correta! Acesso autorizado. Como posso te ajudar?");
      } else {
        await enviarMensagemTelegram(chatId, "🔒 Olá! Este bot é protegido. Por favor, digite a senha de acesso para continuar:");
      }
      return res.sendStatus(200);
    }

    // 2. Gerenciamento do histórico de curto prazo (contexto da conversa)
    if (!historicoConversas.has(chatId)) {
      historicoConversas.set(chatId, []);
    }
    const historico = historicoConversas.get(chatId);

    // Adiciona a nova mensagem do usuário ao histórico
    historico.push({ role: "user", parts: [{ text: text }] });

    // Mantém apenas as últimas 10 mensagens para não sobrecarregar a API
    if (historico.length > 10) {
      historico.shift();
    }

    // 3. Chamada para a API do Gemini enviando todo o histórico de contexto
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: historico
      })
    });

    const geminiData = await geminiRes.json();
    console.log("Resposta completa do Gemini:", JSON.stringify(geminiData));

    let replyText = "Desculpe, ocorreu um erro ao gerar a resposta.";

    if (geminiData.candidates && geminiData.candidates[0]?.content?.parts?.[0]?.text) {
      replyText = geminiData.candidates[0].content.parts[0].text;
      // Adiciona a resposta do bot ao histórico para manter o contexto
      historico.push({ role: "model", parts: [{ text: replyText }] });
    } else if (geminiData.error) {
      replyText = `Erro da API Gemini: ${geminiData.error.message}`;
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
  res.send('Bot Telegram com Gemini rodando com sucesso!');
});

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  if (TELEGRAM_TOKEN) {
    const webhookUrl = `https://telegram-gemini-bot-pmyx.onrender.com/webhook`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
    console.log(`Webhook configurado para: ${webhookUrl}`);
  }
});
