
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

app.get('/', (_req, res) => {
  res.json({ service: 'rafif-bees-api', status: 'ok' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', configured: Boolean(API_KEY) });
});

const checkPrompt = `
أنت مدقّق صور لتطبيق نحالة.
حدّد فقط هل الصورة مناسبة لفحص خلية نحل.
اختر category واحدة فقط من:
brood_frame: إطار حضنة،
comb: أقراص شمعية داخل خلية،
bees_on_comb: نحل بالغ على الأقراص،
hive_entrance: مدخل خلية نحل،
hive_other: جزء واضح من خلية نحل،
single_bee_or_flower: نحلة منفردة أو زهرة فقط،
not_hive: أي صورة أخرى،
unclear: صورة غير واضحة أو لا يمكن التأكد منها.
لا تخمّن. إذا كانت الصورة لشخص أو حيوان آخر أو طعام
أو عسل في عبوة أو سيارة أو مبنى أو منظر طبيعي أو رسم،
اختر not_hive. لا تبدأ تحليل الصحة في هذه المرحلة.
أعد JSON فقط:
{"category":"...","recognition_confidence":0,
"quality":{"level":"good","issues":[]},
"visible_parts":[],"reason":"سبب مختصر بالعربية"}
`;

const analysisPrompt = `
أنت خبير نحالة. حلّل صورة خلية النحل بالعربية.
صف فقط العلامات المرئية فعلًا. لا تخترع معلومات،
ولا تؤكد تشخيص مرض، ولا تقل إن الخلية سليمة لمجرد
عدم ظهور علامات. اذكر العلامات المحتملة ودرجة وضوحها،
والاحتمالات الأخرى، وما ينبغي للنحّال فحصه ميدانيًا.
لا تقيّم قوة الطائفة إذا كانت الصورة لا تُظهر ما يكفي.
أعد JSON فقط بهذا الشكل:
{"summary":"ملخص بالعربية",
"findings":[{"name":"","observed":"","location":null,
"clarity":"clear","may_indicate":"","alternatives":[],
"field_check":"","confidence":0}],
"chalkbrood":{"signs_visible":false,"observed":null,
"confidence":null,"other_possibilities":[],"needs_check":""},
"strength":{"assessable":false,"reason":"",
"brood_pattern":null,"adult_bees":null,"not_visible":[]}}
`;

app.post('/api/analyze', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(503).json({
        error: 'analysis_not_configured'
      });
    }

    const { stage, image, v, mimeType = 'image/jpeg' } =
      req.body || {};

    if (typeof image !== 'string' || image.length < 100) {
      return res.status(400).json({ error: 'bad_image_size' });
    }

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return res.status(415).json({ error: 'unsupported_image' });
    }

    const clean = image.replace(
      /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
      ''
    );
    const buffer = Buffer.from(clean, 'base64');

    if (buffer.length < 100 || buffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'bad_image_size' });
    }

    // المرحلة الثانية لا تعمل إلا بعد تصنيف الصورة كخلية نحل.
    if (Number(stage) !== 1 &&
        !allowedCategories.includes(v?.category)) {
      return res.status(422).json({
        error: 'image_not_bee_hive',
        message: 'الصورة غير مناسبة لتحليل خلية النحل.'
      });
    }

    const ai = new GoogleGenAI({ apiKey: API_KEY });
    const prompt = Number(stage) === 1
      ? checkPrompt
      : analysisPrompt;

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

    if (!result.text) {
      return res.status(502).json({ error: 'upstream_failed' });
    }

    // في المرحلة الأولى نرجع التصنيف فقط.
    return res.json({ text: result.text });
  } catch (err) {
    console.error('Analysis error:', err?.message || err);
    return res.status(502).json({ error: 'upstream_failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rafif API listening on ${PORT}`);
});
