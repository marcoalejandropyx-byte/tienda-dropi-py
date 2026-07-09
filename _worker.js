/**
 * Cloudflare Pages — Advanced mode ( _worker.js en la raíz )
 * ------------------------------------------------------------------
 * Un solo archivo que hace de backend seguro entre tu tienda y la API
 * de Dropi. Rutas:
 *   GET  /api/products   -> lista productos de Dropi (por categoría)
 *   POST /api/order      -> crea un pedido en Dropi
 *   (cualquier otra ruta) -> sirve los archivos estáticos (index.html)
 *
 * La clave de Dropi NUNCA se expone al navegador: vive como variable
 * de entorno cifrada en Cloudflare (DROPI_KEY).
 *
 * Variables de entorno (Cloudflare -> Settings -> Variables and Secrets):
 *   DROPI_KEY            (SECRET) tu clave de integración de Dropi
 *   DROPI_API_BASE       (texto)  ej: https://api.dropi.com.py/api
 *   DROPI_PRODUCTS_PATH  (texto, opcional) def: /integrations/products
 *   DROPI_ORDER_PATH     (texto, opcional) def: /integrations/orders
 * ------------------------------------------------------------------
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/api/products") return handleProducts(request, env, url);
    if (url.pathname === "/api/order")    return handleOrder(request, env);

    // Resto: archivos estáticos (index.html, imágenes, etc.)
    return env.ASSETS.fetch(request);
  },
};

/* ----------------------------- PRODUCTOS ----------------------------- */
async function handleProducts(request, env, url) {
  const KEY  = env.DROPI_KEY;
  const BASE = (env.DROPI_API_BASE || "").replace(/\/$/, "");
  const PATH = env.DROPI_PRODUCTS_PATH || "/integrations/products";

  if (!KEY || !BASE) {
    return json({ ok: false, configured: false, reason: "Faltan DROPI_KEY o DROPI_API_BASE", products: [] });
  }

  const category = url.searchParams.get("category");
  const keywords = url.searchParams.get("keywords");
  const page = Number(url.searchParams.get("page") || "1");

  const payload = {
    scroll_infinite: true,
    order_by: "created_at",
    order_type: "DESC",
    pageSize: 50,
    startData: (page - 1) * 50,
  };
  if (keywords) payload.keywords = keywords;
  if (category) payload.category = [Number(category)];

  try {
    const resp = await fetch(`${BASE}${PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "dropi-integration-key": KEY },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      return json({ ok: false, configured: true, status: resp.status, error: await resp.text(), products: [] });
    }
    const raw = await resp.json();
    const list = raw.objects || raw.data || raw.products || raw.result || [];
    const products = list.map(normalizeProduct).filter((p) => p && p.id);
    return json({ ok: true, configured: true, count: products.length, products },
      200, { "Cache-Control": "public, max-age=300" });
  } catch (err) {
    return json({ ok: false, configured: true, error: String(err), products: [] });
  }
}

function normalizeProduct(p = {}) {
  const price = Number(p.sale_price ?? p.price ?? p.suggested_price ?? 0);
  const cost = Number(p.price ?? p.cost ?? 0);
  const gallery = p.gallery || p.images || [];
  const image =
    p.main_image || p.image ||
    (Array.isArray(gallery) && gallery.length ? (gallery[0].url || gallery[0]) : "") || "";
  return {
    id: p.id ?? p.product_id,
    name: p.name || p.title || "Producto",
    price,
    old: cost && cost > price ? cost : Math.round(price * 1.4),
    image,
    stock: Number(p.stock ?? p.available ?? 0),
    category: (p.categories && p.categories[0] && (p.categories[0].name || p.categories[0])) || p.category || "General",
    desc: (p.description || "").replace(/<[^>]*>/g, "").slice(0, 120),
    sales: p.sold ? `${p.sold} vendidos` : "",
  };
}

/* ------------------------------- ORDEN ------------------------------- */
async function handleOrder(request, env) {
  const KEY  = env.DROPI_KEY;
  const BASE = (env.DROPI_API_BASE || "").replace(/\/$/, "");
  const PATH = env.DROPI_ORDER_PATH || "/integrations/orders";

  if (!KEY || !BASE) return json({ ok: false, configured: false, reason: "Faltan DROPI_KEY o DROPI_API_BASE" });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }

  const c = body.customer || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!c.name || !c.phone || !c.address || items.length === 0) {
    return json({ ok: false, error: "Faltan datos del cliente o productos" }, 400);
  }

  const payload = {
    name: c.name,
    phone: c.phone,
    direction: c.address,
    city: c.city,
    department: c.dept,
    notes: `Pedido web (${body.payment === "cod" ? "contra entrega" : "pago online"})`,
    collection: body.payment === "cod" ? items.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0) : 0,
    products: items.map((it) => ({ id: Number(it.id), price: Number(it.price), quantity: Number(it.qty) })),
  };

  try {
    const resp = await fetch(`${BASE}${PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "dropi-integration-key": KEY },
      body: JSON.stringify(payload),
    });
    const raw = await resp.json().catch(() => ({}));
    if (!resp.ok) return json({ ok: false, status: resp.status, error: raw });
    return json({ ok: true, dropiOrderId: raw.id || raw.order_id || raw.guide || null, raw });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}
