require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

if (!BOT_TOKEN || !GEMINI_API_KEY) {
  console.error('ERRO: Defina TELEGRAM_BOT_TOKEN e GEMINI_API_KEY nas variáveis de ambiente.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

app.use(express.json());

// Rota de verificação do servidor
app.get('/', (req, res) => {
  res.send('Servidor e Bot do Telegram operacionais.');
});

// Endpoint do Webhook do Telegram
const WEBHOOK_PATH = '/telegram-webhook';
app.use(bot.webhookCallback(WEBHOOK_PATH));

// Evento de recepção de texto no Telegram
bot.on('text', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const userPrompt = ctx.message.text;

    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: userPrompt,
    });

    await ctx.reply(response.text || 'Não foi possível gerar uma resposta.');
  } catch (error) {
    console.error('Erro ao processar mensagem no Gemini:', error);
    await ctx.reply('Ocorreu um erro ao processar sua solicitação.');
  }
});

// Inicialização e vinculação do Webhook no Render
app.listen(PORT, async () => {
  console.log(`Servidor ativo na porta ${PORT}`);

  if (RENDER_URL) {
    const fullWebhookUrl = `${RENDER_URL}${WEBHOOK_PATH}`;
    try {
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log(`Webhook registrado com sucesso: ${fullWebhookUrl}`);
    } catch (err) {
      console.error('Falha ao registrar Webhook no Telegram:', err);
    }
  } else {
    console.log('RENDER_EXTERNAL_URL não encontrada. Executando via Polling para testes locais...');
    bot.launch();
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

