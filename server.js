const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const COOKIES_FILE = '/app/cookies/instagram_session.json';
const IG_USER = process.env.IG_USERNAME || '';
const IG_PASS = process.env.IG_PASSWORD || '';

let browserInstance = null;
let isLoggingIn = false;

// ─── Gerenciar browser persistente ───────────────────────────────────────────
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1280,900'
    ]
  });
  return browserInstance;
}

// ─── Login no Instagram ───────────────────────────────────────────────────────
async function ensureLoggedIn(page) {
  // Tentar usar cookies salvos primeiro
  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
      await page.setCookie(...cookies);
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 30000 });

      const loggedIn = await page.evaluate(() =>
        !!document.querySelector('svg[aria-label="Home"]') ||
        !!document.querySelector('a[href="/direct/inbox/"]') ||
        document.title.includes('Instagram')
      );

      if (loggedIn) {
        console.log('✅ Session restaurada com cookies!');
        return true;
      }
    } catch (e) {
      console.log('⚠️ Cookies inválidos, fazendo login novamente...');
    }
  }

  // Login fresco
  console.log('🔐 Fazendo login no Instagram...');
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 30000 });

  await page.waitForSelector('input[name="username"]', { timeout: 15000 });
  await page.type('input[name="username"]', IG_USER, { delay: 80 });
  await page.type('input[name="password"]', IG_PASS, { delay: 80 });
  await page.click('button[type="submit"]');

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

  // Aguardar possíveis modais de "salvar login"
  await new Promise(r => setTimeout(r, 3000));
  try {
    const notNow = await page.$('button:has-text("Agora não"), button:has-text("Not now")');
    if (notNow) await notNow.click();
  } catch (e) {}

  // Salvar cookies para próximas vezes
  const cookies = await page.cookies();
  fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies));
  console.log('✅ Login efetuado e cookies salvos!');
  return true;
}

// ─── Rota principal: buscar comentários ──────────────────────────────────────
app.get('/api/comentarios', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes('instagram.com')) {
    return res.status(400).json({ success: false, error: 'URL inválida. Informe o link completo do post do Instagram.' });
  }

  console.log(`📥 Buscando comentários de: ${url}`);

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await ensureLoggedIn(page);

    // Interceptar respostas da API do Instagram (melhor método)
    const comments = new Map();

    page.on('response', async (response) => {
      const rUrl = response.url();
      if (!rUrl.includes('instagram.com')) return;
      if (!rUrl.includes('comment') && !rUrl.includes('graphql') && !rUrl.includes('api/v1/media')) return;

      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const data = await response.json();

        // Formato GraphQL (web)
        const graphqlEdges =
          data?.data?.shortcode_media?.edge_media_to_parent_comment?.edges ||
          data?.data?.xdt_api__v1__media__shortcode__web_info?.edge_media_to_parent_comment?.edges || [];

        graphqlEdges.forEach(edge => {
          const node = edge?.node;
          const u = node?.owner?.username;
          const t = (node?.text || '').replace(/\n/g, ' ').trim();
          if (u && t) comments.set(`${u}|${t}`, { user: u, comment: t });
        });

        // Formato REST API v1 (mobile)
        const restItems = data?.items || data?.comments || [];
        restItems.forEach(item => {
          const u = item?.user?.username || item?.username;
          const t = (item?.text || item?.comment_text || '').replace(/\n/g, ' ').trim();
          if (u && t) comments.set(`${u}|${t}`, { user: u, comment: t });
        });

      } catch (e) {}
    });

    // Navegar para o post
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Scroll e cliques automáticos por até 3 minutos
    const maxSteps = 360; // 360 × 500ms = 3 minutos
    let unchangedSteps = 0;
    let lastCount = 0;

    for (let i = 0; i < maxSteps; i++) {
      // Clicar em "ver mais comentários" e "+"
      await page.evaluate(() => {
        document.querySelectorAll('button, div[role="button"], span[role="button"]').forEach(btn => {
          const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (txt.includes('mais') || txt.includes('more') || txt.includes('resposta') || txt === '+' || txt === '…') {
            try { btn.click(); } catch (e) {}
          }
        });
        // Rolar todas as caixas de overflow
        document.querySelectorAll('div[role="dialog"], div[style*="overflow"]').forEach(d => {
          d.scrollTop += 3000;
        });
        window.scrollBy(0, 3000);
      });

      await new Promise(r => setTimeout(r, 500));

      if (comments.size === lastCount) {
        unchangedSteps++;
        if (unchangedSteps >= 20 && i > 20) {
          console.log(`✅ Fim dos comentários após ${i} passos. Total: ${comments.size}`);
          break;
        }
      } else {
        unchangedSteps = 0;
        lastCount = comments.size;
        console.log(`📊 ${comments.size} comentários coletados... (passo ${i + 1})`);
      }
    }

    await page.close();

    const result = Array.from(comments.values());
    console.log(`🎉 Extração concluída: ${result.length} comentários!`);

    return res.json({
      success: true,
      total: result.length,
      comentarios: result
    });

  } catch (error) {
    console.error('❌ Erro:', error.message);
    if (page) await page.close().catch(() => {});
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Sorteador API rodando na porta ${PORT}`);
  console.log(`📡 Instagram: ${IG_USER ? '✅ Credenciais configuradas' : '❌ Defina IG_USERNAME e IG_PASSWORD'}`);
});
