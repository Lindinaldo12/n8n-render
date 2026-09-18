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
  console.error('ERRO: TELEGRAM_BOT_TOKEN e GEMINI_API_KEY devem ser configuradas nas variáveis de ambiente.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

app.use(express.json());

// Rota de status do servidor
app.get('/', (req, res) => {
  res.send('Servidor e Bot do Telegram operacionais.');
});

// Caminho do Webhook do Telegram
const WEBHOOK_PATH = `/telegram/${BOT_TOKEN}`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

// Função com fallback automático de modelos do Gemini
async function generateGeminiResponse(prompt) {
  const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
      });
      if (response && response.text) {
        return response.text;
      }
    } catch (err) {
      console.warn(`Aviso: O modelo ${modelName} falhou. Tentando o próximo...`);
      lastError = err;
    }
  }
  throw lastError;
}

// Evento de mensagens do Telegram
bot.on('text', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const userPrompt = ctx.message.text;

    const replyText = await generateGeminiResponse(userPrompt);
    await ctx.reply(replyText);
  } catch (error) {
    console.error('Erro ao gerar resposta no Gemini:', error);
    await ctx.reply('Ocorreu um erro ao processar sua mensagem.');
  }
});

// Inicialização do Servidor Express
app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);

  if (RENDER_URL) {
    const fullWebhookUrl = `${RENDER_URL}${WEBHOOK_PATH}`;
    try {
      // Remove conexões residuais/polling para evitar Erro 409 (Conflict)
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log(`Webhook ativado em: ${fullWebhookUrl}`);
    } catch (err) {
      console.error('Erro ao definir Webhook:', err);
    }
  } else {
    console.log('Ambiente local: rodando via Polling...');
    bot.launch();
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
