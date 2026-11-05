// Checagem do site lupa1.com.br para o Monitoramento de Clientes.
// Lê todas as matérias publicadas (de hoje até 40 dias antes do início do mês),
// procura o nome de cada cliente no título, na linha fina e no texto, e grava
// dados/monitoramento/materias.json e varredura.json.
// Clientes em removidos.json ficam de fora.
import { readFile, writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const SITE = 'https://lupa1.com.br';
const DIR = new URL('../dados/monitoramento/', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const lerJson = async (nome, padrao) => { try { return JSON.parse(await readFile(new URL(nome, DIR), 'utf8')); } catch { return padrao; } };
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const espera = ms => new Promise(r => setTimeout(r, ms));

async function baixar(url, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
      console.log(`aviso: ${url} respondeu ${r.status} (${r.headers.get('server') || ''})`);
    } catch (e) { console.log(`aviso: ${url} falhou: ${e.cause?.code || e.message}`); }
    await espera(1500 * (i + 1));
  }
  return null;
}

async function materia(url) {
  const html = await baixar(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  let hl = '', ds = '';
  try { const j = JSON.parse($('script[type="application/ld+json"]').first().text()); hl = j.headline || ''; ds = j.description || ''; } catch {}
  const corpo = $('.contentPost').first();
  corpo.find('aside, script, style, iframe').remove();
  const pub = $('meta[property="article:published_time"]').attr('content') || '';
  return { u: url, hl, pub, n: norm(`${hl} . ${ds} . ${corpo.text()}`).replace(/\s+/g, ' ') };
}

async function emLotes(urls, fn, lote = 8) {
  const out = [];
  for (let i = 0; i < urls.length; i += lote) out.push(...(await Promise.all(urls.slice(i, i + lote).map(fn))).filter(Boolean));
  return out;
}

const linksDe = html => {
  const $ = cheerio.load(html);
  const set = new Set();
  $('a[href$=".html"]').each((_, a) => {
    const h = new URL($(a).attr('href'), SITE).href;
    if (/\/noticias\/.+-\d+\.html$/.test(h)) set.add(h);
  });
  return [...set];
};

const clientes = await lerJson('clientes.json', []);
const removidos = new Set((await lerJson('removidos.json', [])).map(x => x.cliente_id));
const ativos = clientes.filter(c => !removidos.has(c.cliente_id));
if (!ativos.length) throw new Error('Lista de clientes vazia');

const agora = new Date(Date.now() - 3 * 3600e3); // horário de Brasília
const mes = agora.toISOString().slice(0, 7);
const corte = new Date(Date.parse(mes + '-01T00:00:00Z') - 40 * 864e5).toISOString().slice(0, 10);

// 1. Todas as matérias, página por página, até passar do corte
const arts = new Map();
for (let p = 1; p < 150; p++) {
  const html = await baixar(`${SITE}/noticias?page=${p}`);
  if (!html) { if (p === 1) throw new Error('Não consegui abrir a lista de notícias do site'); break; }
  const novos = linksDe(html).filter(u => !arts.has(u));
  const lidos = await emLotes(novos, materia);
  lidos.forEach(a => arts.set(a.u, a));
  const datas = lidos.map(a => a.pub.slice(0, 10)).filter(Boolean).sort();
  console.log(`página ${p}: ${lidos.length} matérias, total ${arts.size}`);
  if (!datas.length || datas[Math.floor(datas.length / 2)] < corte) break;
}
if (arts.size < 100) throw new Error(`Poucas matérias lidas (${arts.size}); nada foi gravado`);

const regex = p => new RegExp(`(?<![A-Za-z])(?:${p})(?![a-z])`);
const casa = (c, a) => c.padroes.some(p => regex(p).test(a.n)) && (c.exige || []).every(p => regex(p).test(a.n));

const achados = {};
for (const c of ativos) achados[c.cliente_id] = [...arts.values()].filter(a => casa(c, a));

// 2. Clientes sem nada no período: última matéria pela busca do site
for (const c of ativos) {
  if (achados[c.cliente_id].length || !c.busca) continue;
  const html = await baixar(`${SITE}/buscar/noticias?term=${encodeURIComponent(c.busca)}`);
  if (!html) continue;
  const $ = cheerio.load(html);
  const caixa = $('div').filter((_, d) => ($(d).attr('class') || '').includes('mx-auto space-y-8')).first();
  const urls = [...new Set(caixa.find('a[href$=".html"]').map((_, a) => new URL($(a).attr('href'), SITE).href).get())];
  achados[c.cliente_id] = (await emLotes(urls, materia)).filter(a => casa(c, a));
}

// 3. Matérias que citam 10 ou mais municípios clientes (listas)
const porMateria = {};
for (const c of ativos) if (c.categoria === 'Município') for (const a of achados[c.cliente_id]) porMateria[a.u] = (porMateria[a.u] || 0) + 1;

const materias = [];
for (const c of ativos) {
  const v = achados[c.cliente_id].sort((a, b) => b.pub.localeCompare(a.pub));
  const doMes = v.filter(a => a.pub.slice(0, 7) === mes);
  const antes = v.find(a => a.pub.slice(0, 7) < mes);
  for (const a of antes ? [...doMes, antes] : doMes) {
    materias.push({ cliente_id: c.cliente_id, data: a.pub.slice(0, 16), link: a.u, titulo: a.hl, lista: (porMateria[a.u] || 0) >= 10 ? 1 : 0 });
  }
}

const checado = agora.toISOString().slice(0, 16);
await writeFile(new URL('materias.json', DIR), JSON.stringify(materias, null, 0) + '\n');
await writeFile(new URL('varredura.json', DIR), JSON.stringify([{ mes, checado_em: checado, artigos_lidos: arts.size }]) + '\n');
console.log(`Pronto: ${arts.size} matérias lidas, ${materias.length} citações gravadas, ${removidos.size} clientes removidos, checado em ${checado}.`);
