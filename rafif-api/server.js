
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();

app.use(cors({
  origin: 'https://eng-maryam-2003.github.io',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '12mb' }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const allowedCategories = [
  'brood_frame',
  'comb',
  'bees_on_comb',
  'hive_entrance',
  'hive_other'
];

const checkPrompt = `
أنت مدقق صور لتطبيق نحالة.
افحص الصورة نفسها وحدد هل هي صورة مناسبة لفحص خلية نحل.

التصنيفات المسموحة:
brood_frame: إطار حضنة واضح.
comb: أقراص شمعية داخل خلية.
bees_on_comb: نحل بالغ على الأقراص.
hive_entrance: مدخل خلية نحل واضح.
hive_other: جزء واضح من خلية نحل.

تصنيفات الرفض:
single_bee_or_flower: نحلة منفردة أو زهرة فقط.
not_hive: شخص أو حيوان آخر أو طعام أو عبوة عسل
أو سيارة أو مبنى أو منظر طبيعي أو صورة لا تخص النحل.
unclear: صورة غير واضحة أو لا يمكن التأكد منها.

لا تخمّن التصنيف.
لا تعتبر وجود اللون الأصفر أو وجود زهرة دليلًا على أنها خلية نحل.
لا تبدأ تحليل الصحة.

أعد JSON فقط بالشكل:
{
  "category": "not_hive",
  "recognition_confidence": 0,
  "quality": {
    "level": "poor",
    "issues": []
  },
  "visible_parts": [],
  "reason": "سبب مختصر بالعربية"
}
`;

const analysisPrompt = `
أنت خبير نحالة. حلل صورة خلية النحل بالعربية.
صف العلامات المرئية فعلًا فقط.
لا تخترع معلومات ولا تؤكد تشخيص مرض.
عدم ظهور علامات مرض لا يعني أن الخلية سليمة.
اذكر ما ينبغي للنحال فحصه ميدانيًا.
لا تقيّم قوة الطائفة إن كانت الصورة لا تكفي.

أعد JSON فقط بالشكل:
{
  "summary": "ملخص بالعربية",
  "findings": [],
  "chalkbrood": {
    "signs_visible": false,
    "observed": null,
    "confidence": null,
    "other_possibilities": [],
    "needs_check": ""
  },
  "strength": {
    "assessable": false,
    "reason": "",
    "brood_pattern": null,
    "adult_bees": null,
    "not_visible": []
  }
}
`;

app.get('/', (_req, res) => {
  res.json({
    service: 'rafif-bees-api',
    status: 'ok'
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    configured: Boolean(API_KEY)
  });
});

function parseModelJSON(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('empty_model_response');
  }

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  return JSON.parse(cleaned);
}

async function askGemini(ai, prompt, mimeType, buffer) {
  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType,
            data: buffer.toString('base64')
          }
        }
      ]
    }],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.2
    }
  });

  return parseModelJSON(result.text);
}

app.post('/api/analyze', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(503).json({
        error: 'analysis_not_configured',
        message: 'مفتاح تحليل الصور غير مضبوط على الخادم.'
      });
    }

    const {
      stage,
      image,
      mimeType = 'image/jpeg'
    } = req.body || {};

    if (![1, 2].includes(Number(stage))) {
      return res.status(400).json({
        error: 'invalid_stage',
        message: 'مرحلة الطلب غير صحيحة.'
      });
    }

    if (typeof image !== 'string' || image.length < 100) {
      return res.status(400).json({
        error: 'bad_image_size',
        message: 'الصورة فارغة أو غير صالحة.'
      });
    }

    if (![
      'image/jpeg',
      'image/png',
      'image/webp'
    ].includes(mimeType)) {
      return res.status(415).json({
        error: 'unsupported_image',
        message: 'الصيغ المدعومة هي JPG وPNG وWEBP.'
      });
    }

    const clean = image.replace(
      /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
      ''
    );

    // التحقق من صيغة Base64 قبل فكها.
    if (
      clean.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)
    ) {
      return res.status(400).json({
        error: 'invalid_image_encoding',
        message: 'تعذر قراءة بيانات الصورة.'
      });
    }

    const buffer = Buffer.from(clean, 'base64');

    if (
      buffer.length < 100 ||
      buffer.length > 8 * 1024 * 1024
    ) {
      return res.status(400).json({
        error: 'bad_image_size',
        message: 'حجم الصورة يجب ألا يتجاوز 8 ميغابايت.'
      });
    }

    const ai = new GoogleGenAI({ apiKey: API_KEY });

    // المرحلة الأولى: تصنيف الصورة.
    const recognition = await askGemini(
      ai,
      checkPrompt,
      mimeType,
      buffer
    );

    const category = recognition.category;

    const isBee = allowedCategories.includes(category);

    // نرفض الصور غير المناسبة قبل أي تحليل صحي.
    if (!isBee) {
      return res.status(422).json({
        isBee: false,
        category: category || 'unclear',
        recognition_confidence:
          recognition.recognition_confidence ?? 0,
        message:
          recognition.reason ||
          'الصورة لا تبدو صورة مناسبة لفحص خلية نحل.',
        quality: recognition.quality || null,
        visible_parts: recognition.visible_parts || []
      });
    }

    // المرحلة الأولى تنتهي بالتصنيف فقط.
    if (Number(stage) === 1) {
      return res.json({
        isBee: true,
        category,
        recognition_confidence:
          recognition.recognition_confidence ?? 0,
        message: 'تم قبول الصورة مبدئيًا لفحص خلية النحل.',
        quality: recognition.quality || null,
        visible_parts: recognition.visible_parts || []
      });
    }

    // المرحلة الثانية: لا تصل إلى هنا إلا بعد فحص الصورة
    // فعليًا على الخادم والتأكد من تصنيفها ضمن الفئات المقبولة.
    const analysis = await askGemini(
      ai,
      analysisPrompt,
      mimeType,
      buffer
    );

    return res.json({
      isBee: true,
      category,
      analysis
    });

  } catch (err) {
    console.error(
      'Analysis error:',
      err?.message || err
    );

    return res.status(502).json({
      error: 'upstream_failed',
      message:
        'تعذر التحقق من الصورة أو تحليلها. حاولي مرة أخرى.'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rafif API listening on ${PORT}`);
});
