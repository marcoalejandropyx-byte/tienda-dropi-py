/**
 * Cloudflare Pages — Advanced mode ( _worker.js en la raíz )
 * ------------------------------------------------------------------
 * La landing muestra TODOS los productos de tu tienda SHOPIFY
 * (sincronizada con Dropi vía Dropify) y permite CERRAR VENTAS
 * contra entrega directo desde la página (crea el pedido en Shopify).
 *
 * Nota dropshipping: los productos se muestran SIEMPRE disponibles
 * (el stock real lo maneja Dropi, no tu tienda), así nunca aparece
 * "AGOTADO" por un inventario 0 en Shopify.
 *
 * Lectura de productos:
 *   - Si hay SHOPIFY_ADMIN_TOKEN -> usa la Admin API y muestra TODOS
 *     los productos automáticamente (no importa el canal). ✅ auto-sync
 *   - Si no, usa la Storefront API (productos publicados en el canal).
 *
 * Rutas:
 *   GET  /api/products      -> lista productos
 *   GET  /api/product?id=   -> detalle de un producto
 *   POST /api/order         -> crea pedido contra entrega (Admin API)
 *   (otras)                 -> archivos estáticos (index.html, producto.html)
 *
 * Variables de entorno (Cloudflare -> Settings -> Variables and Secrets):
 *   SHOPIFY_DOMAIN            (texto)   ej: 00kv0v-ck.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN       (SECRETO) token de Admin API (read_products, write_orders)
 *   SHOPIFY_STOREFRONT_TOKEN  (texto)   token público Storefront (opcional, respaldo)
 *   SHOPIFY_API_VERSION       (texto, opcional) def: 2024-10
 *
 *   --- Filtro de STOCK real (ver sección "FILTRO DE STOCK + DROPI" más abajo) ---
 *   STOCK_MODE   (texto, opcional) def: off | "shopify" | "dropi"
 *   DROPI_API_BASE   (texto)   base de la API de Dropi, sin slash final
 *   DROPI_KEY        (SECRETO) token de la sección "Integraciones" del panel Dropi
 * ------------------------------------------------------------------
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}
const clean = (s) => (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/api/products") return handleProducts(env);
    if (url.pathname === "/api/product") return handleProduct(env, url.searchParams.get("id"));
    if (url.pathname === "/api/order" && request.method === "POST") return handleOrder(env, request);
    if (url.pathname === "/api/checkout" && request.method === "POST") return handleCheckout(env, request);
    if (url.pathname === "/api/dropi-selftest") return handleDropiSelftest(env);
    if (url.pathname === "/api/dropi-probe") return handleDropiProbe(env, url);
    // Feed de catálogo para Meta Ads (Commerce Manager). XML por defecto, CSV opcional.
    if (url.pathname === "/feed.csv") return handleFeed(env, url, "csv");
    if (url.pathname === "/feed.xml" || url.pathname === "/feed") return handleFeed(env, url, "xml");
    return env.ASSETS.fetch(request);
  },
};

/* --------- Helpers Shopify --------- */
async function adminGET(env, path) {
  const DOMAIN = env.SHOPIFY_DOMAIN, ADMIN = env.SHOPIFY_ADMIN_TOKEN;
  const VERSION = env.SHOPIFY_API_VERSION || "2024-10";
  const r = await fetch(`https://${DOMAIN}/admin/api/${VERSION}${path}`, {
    headers: { "X-Shopify-Access-Token": ADMIN, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`Admin HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}
async function storefront(env, query, variables) {
  const DOMAIN = env.SHOPIFY_DOMAIN, TOKEN = env.SHOPIFY_STOREFRONT_TOKEN;
  const VERSION = env.SHOPIFY_API_VERSION || "2024-10";
  const r = await fetch(`https://${DOMAIN}/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`Storefront HTTP ${r.status}`);
  return r.json();
}

function mapAdminProduct(p) {
  const v = (p.variants && p.variants[0]) || {};
  const price = Math.round(Number(v.price || 0));
  const compare = Math.round(Number(v.compare_at_price || 0));
  // Inventario REAL en Shopify (Dropify lo sincroniza desde Dropi):
  //  - inventory_management != null  => Shopify trackea stock => usamos inventory_quantity
  //  - inventory_management == null   => no se trackea => _shopStock = null (desconocido)
  const invQty = Number(v.inventory_quantity || 0);
  const shopStock = v.inventory_management ? invQty : null;
  return {
    id: String(p.id),
    variantId: v.id ? String(v.id) : "",
    sku: v.sku || "",
    name: p.title,
    price,
    old: compare > price ? compare : Math.round(price * 1.3),
    image: (p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src) || "",
    images: (p.images || []).map((i) => i.src),
    stock: 99,           // valor de DISPLAY por defecto (dropshipping: siempre "Disponible")
    available: true,
    _shopStock: shopStock,   // interno: se elimina antes de responder (ver stripInternal)
    _shopAvail: null,        // interno: Admin usa cantidad, no availableForSale
    category: p.product_type || "General",
    descHtml: p.body_html || "",
    desc: clean(p.body_html).slice(0, 140),
    sales: "",
  };
}

/* ------------------------------ LISTA ------------------------------ */
async function handleProducts(env) {
  if (!env.SHOPIFY_DOMAIN) return json({ ok: false, configured: false, products: [] });

  // Preferimos Admin API => trae TODOS los productos (auto-sync total)
  if (env.SHOPIFY_ADMIN_TOKEN) {
    try {
      const data = await adminGET(env, "/products.json?limit=250&status=active");
      let products = (data.products || []).map(mapAdminProduct).filter((p) => p.id);
      products = (await applyStockFilter(env, products)).map(stripInternal);
      return json({ ok: true, configured: true, source: "admin", count: products.length, products },
        200, { "Cache-Control": "public, max-age=120" });
    } catch (e) { /* si falla, probamos Storefront abajo */ }
  }

  // Respaldo: Storefront (solo publicados en el canal Headless)
  if (!env.SHOPIFY_STOREFRONT_TOKEN) return json({ ok: false, configured: false, products: [] });
  try {
    const q = `{ products(first: 50, sortKey: CREATED_AT, reverse: true) { edges { node {
      id title description productType featuredImage { url }
      variants(first:1){ edges { node { id sku availableForSale price{amount} compareAtPrice{amount} } } } } } } }`;
    const data = await storefront(env, q);
    const edges = (data.data && data.data.products && data.data.products.edges) || [];
    let products = edges.map(({ node }) => {
      const v = (node.variants.edges[0] && node.variants.edges[0].node) || {};
      const price = Math.round(Number((v.price && v.price.amount) || 0));
      const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
      return {
        id: node.id.split("/").pop(), variantId: v.id ? v.id.split("/").pop() : "",
        sku: v.sku || "",
        name: node.title, price, old: compare > price ? compare : Math.round(price * 1.3),
        image: node.featuredImage ? node.featuredImage.url : "",
        stock: 99, available: true,
        _shopStock: null,   // Storefront no expone cantidad exacta sin scope de inventario
        _shopAvail: (typeof v.availableForSale === "boolean" ? v.availableForSale : null),
        category: node.productType || "General",
        desc: clean(node.description).slice(0, 140), sales: "",
      };
    });
    products = (await applyStockFilter(env, products)).map(stripInternal);
    return json({ ok: true, configured: true, source: "storefront", count: products.length, products },
      200, { "Cache-Control": "public, max-age=120" });
  } catch (e) { return json({ ok: false, configured: true, error: String(e), products: [] }); }
}

/* ----------------------------- DETALLE ----------------------------- */
async function handleProduct(env, id) {
  if (!id) return json({ ok: false, error: "Falta id" }, 400);
  if (env.SHOPIFY_ADMIN_TOKEN) {
    try {
      const data = await adminGET(env, `/products/${encodeURIComponent(id)}.json`);
      if (data.product) return json({ ok: true, configured: true, product: mapAdminProduct(data.product) },
        200, { "Cache-Control": "public, max-age=120" });
    } catch (e) { /* fallback */ }
  }
  if (!env.SHOPIFY_STOREFRONT_TOKEN) return json({ ok: false, configured: false });
  try {
    const gid = `gid://shopify/Product/${id}`;
    const q = `query($id:ID!){ product(id:$id){ id title descriptionHtml description productType
      images(first:8){edges{node{url}}} variants(first:1){edges{node{ id sku price{amount} compareAtPrice{amount} }}} } }`;
    const data = await storefront(env, q, { id: gid });
    const p = data.data && data.data.product;
    if (!p) return json({ ok: false, error: "no encontrado" }, 404);
    const v = (p.variants.edges[0] && p.variants.edges[0].node) || {};
    const price = Math.round(Number((v.price && v.price.amount) || 0));
    const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
    const images = p.images.edges.map((e) => e.node.url);
    return json({ ok: true, configured: true, product: {
      id, variantId: v.id ? v.id.split("/").pop() : "", sku: v.sku || "", name: p.title, price,
      old: compare > price ? compare : Math.round(price * 1.3), images, image: images[0] || "",
      descHtml: p.descriptionHtml || "", desc: clean(p.description).slice(0, 200),
      category: p.productType || "General", available: true,
    } }, 200, { "Cache-Control": "public, max-age=120" });
  } catch (e) { return json({ ok: false, error: String(e) }); }
}

/* --------------- CHECKOUT REAL (Storefront cartCreate -> checkoutUrl) --------------- */
/* Crea un carrito en Shopify y devuelve la URL del checkout oficial (tarjeta,
   transferencia o contra entrega según los métodos activos en la tienda).
   No requiere Admin token: funciona con el Storefront token público. */
async function handleCheckout(env, request) {
  if (!env.SHOPIFY_STOREFRONT_TOKEN) return json({ ok: false, error: "Falta SHOPIFY_STOREFRONT_TOKEN" });
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }
  const vid = String(b.variantId || "").replace(/\D/g, "");
  const qty = Math.max(1, Number(b.qty || 1));
  if (!vid) return json({ ok: false, error: "Falta la variante del producto" }, 400);
  const gid = `gid://shopify/ProductVariant/${vid}`;
  const q = `mutation($lines:[CartLineInput!]!){
    cartCreate(input:{ lines:$lines }){
      cart { checkoutUrl }
      userErrors { field message }
    }
  }`;
  try {
    const data = await storefront(env, q, { lines: [{ merchandiseId: gid, quantity: qty }] });
    const cc = data.data && data.data.cartCreate;
    const link = cc && cc.cart && cc.cart.checkoutUrl;
    if (!link) return json({ ok: false, error: (cc && cc.userErrors) || data.errors || "sin checkoutUrl" });
    return json({ ok: true, checkoutUrl: link });
  } catch (e) { return json({ ok: false, error: String(e) }); }
}

/* ============================================================================
 * FILTRO DE STOCK REAL  +  INTEGRACIÓN DROPI   (punto 1)
 * ----------------------------------------------------------------------------
 * STOCK_MODE (env var) decide qué productos se muestran:
 *   "off"      (default)  -> comportamiento actual: TODO disponible (no filtra)
 *   "shopify"             -> filtra por el inventario que Dropify YA sincroniza
 *                            dentro de Shopify (availableForSale / inventory_quantity).
 *                            No necesita la API de Dropi.
 *   "dropi"               -> filtra consultando la API de integración de Dropi
 *                            (dropiStock) y cruzando por SKU.
 *
 * El filtro NUNCA rompe la tienda: ante cualquier error o dato faltante,
 * devuelve el catálogo tal cual (todos disponibles).
 *
 * Env vars de Dropi:
 *   DROPI_API_BASE     base de la API SIN slash final. ej: https://api.dropi.com.py
 *   DROPI_KEY (SECRETO) token de la sección "Integraciones" del panel Dropi
 *   DROPI_EMAIL / DROPI_PASSWORD  (opcional) solo si la cuenta es de "uso privado"
 *                      y hay que loguearse por API para obtener el token
 *   DROPI_STRICT       "1" para OCULTAR también los SKU que Dropi no reconoce
 *
 * ⚠️ Los PATHS y el HEADER de abajo son los valores por defecto más probables,
 *    pero DEBEN confirmarse con el PDF oficial "Documentación API de Integraciones
 *    Dropi". Son overrideables por env var (sin re-deploy de código):
 *      DROPI_KEY_HEADER    (def: dropi-integration-key)
 *      DROPI_PRODUCTS_PATH (def: /integrations/products)
 *      DROPI_LOGIN_PATH    (def: /integrations/login)
 *    Probar los valores reales con:  GET /api/dropi-selftest
 * ========================================================================== */

// Quita los campos internos (_shop*) antes de responder al cliente.
function stripInternal(p) {
  const { _shopStock, _shopAvail, ...rest } = p;
  return rest;
}

async function applyStockFilter(env, products) {
  const mode = (env.STOCK_MODE || "off").toLowerCase();
  if (mode === "off" || !products.length) return products;
  try {
    if (mode === "shopify") {
      // Mostrar solo lo comprable / con inventario > 0 según Shopify.
      //  _shopAvail === false      => agotado
      //  _shopStock (si se conoce) <= 0 => agotado
      const inStock = products.filter((p) =>
        p._shopAvail !== false && (p._shopStock == null || p._shopStock > 0));
      return inStock.map((p) => ({ ...p, stock: p._shopStock == null ? p.stock : p._shopStock }));
    }
    if (mode === "dropi") {
      const stockMap = await dropiStock(env);
      if (!stockMap) return products; // Dropi falló => no romper la tienda
      const strict = /^(1|true|si|sí)$/i.test(env.DROPI_STRICT || "");
      const inStock = products.filter((p) => {
        const sku = (p.sku || "").trim();
        if (!sku || !(sku in stockMap)) return !strict; // SKU no mapeado: por defecto NO ocultar
        return Number(stockMap[sku]) > 0;
      });
      return inStock.map((p) => {
        const sku = (p.sku || "").trim();
        return sku in stockMap ? { ...p, stock: Number(stockMap[sku]) } : p;
      });
    }
  } catch (e) { /* cualquier error => catálogo sin filtrar */ }
  return products;
}

/* --------- Config + helpers de la API de Dropi --------- */
function dropiCfg(env) {
  return {
    base: (env.DROPI_API_BASE || "").replace(/\/+$/, ""),
    key: env.DROPI_KEY || "",
    header: env.DROPI_KEY_HEADER || "dropi-integration-key",
    productsPath: env.DROPI_PRODUCTS_PATH || "/integrations/products",
    loginPath: env.DROPI_LOGIN_PATH || "/integrations/login",
    email: env.DROPI_EMAIL || "",
    pass: env.DROPI_PASSWORD || "",
  };
}

// Cache simple del token de login (por isolate). Solo se usa el flujo login si
// NO hay DROPI_KEY directo pero SÍ hay email+password.
let _dropiTok = { v: "", exp: 0 };

async function dropiAuthValue(env, cfg) {
  if (cfg.key) return cfg.key;              // token del panel (caso normal)
  if (!(cfg.email && cfg.pass)) return "";  // sin credenciales
  const now = Date.now();
  if (_dropiTok.v && _dropiTok.exp > now) return _dropiTok.v;
  const tok = await dropiLogin(env, cfg);
  if (tok) _dropiTok = { v: tok, exp: now + 50 * 60 * 1000 }; // ~50 min
  return tok || "";
}

async function dropiLogin(env, cfg) {
  try {
    const r = await fetch(cfg.base + cfg.loginPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.email, password: cfg.pass }),
    });
    const d = await r.json().catch(() => ({}));
    // La forma de la respuesta depende de la doc; probamos campos comunes.
    return d.token || d.dropiToken || (d.data && (d.data.token || d.data.dropiToken)) || "";
  } catch (e) { return ""; }
}

async function dropiFetchJSON(env, cfg, path, init = {}) {
  const auth = await dropiAuthValue(env, cfg);
  if (!cfg.base || !auth) return { ok: false, error: "Dropi no configurado (falta DROPI_API_BASE o credenciales)" };
  try {
    const r = await fetch(cfg.base + path, {
      ...init,
      headers: { "Content-Type": "application/json", [cfg.header]: auth, ...(init.headers || {}) },
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Lista de productos de Dropi (para stock y, a futuro, crear pedidos — punto 2).
async function dropiProducts(env) {
  const cfg = dropiCfg(env);
  const res = await dropiFetchJSON(env, cfg, cfg.productsPath, { method: "GET" });
  if (!res.ok) return res;
  const d = res.data;
  const arr = Array.isArray(d) ? d : (d && (d.objects || d.products || d.data || d.items)) || [];
  return { ok: true, status: res.status, products: Array.isArray(arr) ? arr : [] };
}

// Mapa { sku: cantidad } para cruzar con los productos de Shopify.
// ⚠️ Ajustar los nombres de campo (sku / stock) a la respuesta REAL de Dropi.
async function dropiStock(env) {
  const res = await dropiProducts(env);
  if (!res.ok) return null;
  const map = {};
  for (const it of res.products) {
    const sku = String(it.sku ?? it.SKU ?? it.code ?? it.reference ?? it.id ?? "").trim();
    if (!sku) continue;
    const qty = Number(it.stock ?? it.quantity ?? it.inventory ?? it.available ?? it.stock_available ?? 0);
    map[sku] = Number.isFinite(qty) ? qty : 0;
  }
  return map;
}

// Sonda temporal: GET /api/dropi-probe
// La API responde 200 pero con 0 productos → probamos rutas y parámetros de
// paginación distintos hasta dar con la combinación que SÍ devuelve datos.
// Muestra un recorte del cuerpo CRUDO (nunca el token) para ver la forma real.
const DROPI_PRUEBAS = [
  ["GET", "/integrations/products", null],
  ["GET", "/integrations/products?pageSize=50&startData=0", null],
  ["GET", "/integrations/products?startData=0&endData=50", null],
  ["GET", "/integrations/products?page=1&pageSize=50", null],
  ["GET", "/integrations/products?limit=50&offset=0", null],
  ["GET", "/integrations/products?per_page=50&page=1", null],
  ["POST", "/integrations/products", { pageSize: 50, startData: 0 }],
  ["GET", "/integrations/products/index?pageSize=50&startData=0", null],
  ["GET", "/integrations/my-products?pageSize=50&startData=0", null],
  ["GET", "/integrations/user/products?pageSize=50&startData=0", null],
  ["GET", "/products?pageSize=50&startData=0", null],
  ["GET", "/integrations/categories", null],
  ["GET", "/integrations/orders?pageSize=5&startData=0", null],
];

// El host configurado devolvía el HTML del panel Angular en vez de JSON:
// o sea la ruta /api de app.dropi.com.py NO es la API. Probamos otros hosts.
const DROPI_BASES = [
  "https://api.dropi.com.py",
  "https://api.dropi.com.py/api",
  "https://app.dropi.com.py/api",
  "https://dropi.com.py/api",
  "https://api.dropi.co",
  "https://api.dropi.co/api",
];

async function handleDropiProbe(env, url) {
  const cfg = dropiCfg(env);
  if (!cfg.key) return json({ ok: false, hint: "Falta DROPI_KEY" });

  // Paso 1: ¿qué host devuelve JSON de verdad?
  if (url.searchParams.get("bases") === "1") {
    const hosts = [];
    for (const base of DROPI_BASES) {
      const c = { ...cfg, base };
      const r = await dropiFetchJSON(env, c, "/integrations/products?pageSize=5&startData=0");
      const esHtml = typeof r.data === "string" && /^\s*<(!doctype|html)/i.test(r.data);
      hosts.push({
        base,
        status: r.status ?? null,
        tipo: esHtml ? "HTML (panel web, NO es la API)" : (typeof r.data === "object" ? "JSON ✅" : "texto"),
        error: r.error || null,
        crudo: typeof r.data === "string" ? r.data.slice(0, 160) : JSON.stringify(r.data).slice(0, 400),
      });
    }
    return json({ ok: true, hosts });
  }

  // Paso 2: sobre un host que sí hable JSON, probar rutas/paginación.
  const base = url.searchParams.get("base") || cfg.base;
  const resultados = [];
  for (const [metodo, ruta, cuerpo] of DROPI_PRUEBAS) {
    const init = { method: metodo };
    if (cuerpo) init.body = JSON.stringify(cuerpo);
    const r = await dropiFetchJSON(env, { ...cfg, base }, ruta, init);
    const d = r.data;
    // ¿Cuántos objetos vinieron, en cualquiera de las formas conocidas?
    let n = null;
    if (Array.isArray(d)) n = d.length;
    else if (d && typeof d === "object") {
      for (const k of ["objects", "products", "data", "items", "result", "rows"]) {
        if (Array.isArray(d[k])) { n = d[k].length; break; }
      }
    }
    resultados.push({
      prueba: metodo + " " + ruta,
      status: r.status ?? null,
      encontrados: n,
      claves: d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d).slice(0, 12) : null,
      crudo: typeof d === "string" ? d.slice(0, 300) : JSON.stringify(d).slice(0, 500),
    });
  }
  const gano = resultados.find((r) => r.encontrados > 0);
  return json({ ok: true, base, ganadora: gano ? gano.prueba : null, resultados });
}

// Diagnóstico temporal: GET /api/dropi-selftest  (NO expone el token).
// BORRAR cuando la integración esté validada.
async function handleDropiSelftest(env) {
  const cfg = dropiCfg(env);
  const out = {
    ok: true,
    config: {
      base: cfg.base || null, header: cfg.header,
      productsPath: cfg.productsPath, loginPath: cfg.loginPath,
      hasKey: !!cfg.key, hasLogin: !!(cfg.email && cfg.pass),
      stockMode: env.STOCK_MODE || "off",
    },
  };
  if (!cfg.base || (!cfg.key && !(cfg.email && cfg.pass))) {
    out.ok = false;
    out.hint = "Falta DROPI_API_BASE y/o DROPI_KEY (o DROPI_EMAIL + DROPI_PASSWORD).";
    return json(out);
  }
  const res = await dropiProducts(env);
  out.request = { url: cfg.base + cfg.productsPath, status: res.status || null, ok: res.ok };
  if (res.ok) { out.sampleCount = res.products.length; out.sample = res.products.slice(0, 2); }
  else { out.error = res.data || res.error; }
  return json(out);
}

/* ============================================================================
 * FEED PARA META ADS  (catálogo del Commerce Manager)
 * ----------------------------------------------------------------------------
 * Rutas:  /feed.xml  (RSS 2.0, por defecto)   ·   /feed.csv   ·   /feed (=xml)
 *
 * Lista TODOS los productos de la tienda con los campos que Meta pide
 * (id, title, description, availability, condition, price, link, image_link,
 * brand + fotos extra). Meta chequea esta URL solita (feed programado) y arma
 * la publicidad por catálogo.
 *
 * Reglas importantes:
 *  - Disponibilidad = MISMO criterio que la tienda (STOCK_MODE): por defecto
 *    (dropshipping) TODO va "in stock"; con STOCK_MODE=shopify|dropi respeta el
 *    stock real. Los agotados se MARCAN "out of stock" (no se sacan del feed,
 *    así Meta no pierde el aprendizaje del anuncio).
 *  - NUNCA expone datos internos (acá los productos de Shopify no traen costo,
 *    así que no hay margen que filtrar; el feed solo emite campos públicos).
 *  - El identificador (retailer_id de Meta) = id de producto de Shopify, el
 *    MISMO que usa el link producto.html?id=... → todo cierra.
 *
 * Env vars opcionales:
 *   FEED_BRAND  (texto)  marca que se manda a Meta. def: "Tienda Dropi"
 *   SITE_URL    (texto)  dominio para armar los links absolutos.
 *                        def: se deriva del request (https://tienda-dropi.pages.dev)
 * ========================================================================== */
const FEED_MAX_AGE = 900; // 15 min de caché en el borde

function feedBrand(env) { return (env.FEED_BRAND || "Tienda Dropi").trim(); }
function siteOrigin(env, url) {
  const s = (env.SITE_URL || "").trim().replace(/\/+$/, "");
  return s || url.origin;
}
// Disponibilidad del feed según STOCK_MODE (el MISMO criterio que usa la tienda):
//   "off" (default, dropshipping) => SIEMPRE "in stock" (el stock real está en
//         Dropi, no en Shopify; así Meta no deja de anunciar algo vendible).
//   "shopify" => usa el inventario real de Shopify (availableForSale / cantidad).
//   "dropi"   => usa el stock de la API de Dropi cruzado por SKU.
function feedAvailability(p, mode, dropiMap) {
  if (mode === "shopify") {
    if (p._shopAvail === false) return "out of stock";
    if (p._shopStock != null && Number(p._shopStock) <= 0) return "out of stock";
    return "in stock";
  }
  if (mode === "dropi" && dropiMap) {
    const sku = (p.sku || "").trim();
    if (sku && sku in dropiMap) return Number(dropiMap[sku]) > 0 ? "in stock" : "out of stock";
    return "in stock"; // SKU no mapeado => no ocultar (mismo criterio que la tienda)
  }
  return "in stock"; // off (default): dropshipping, todo disponible
}

// Carga los productos CRUDOS (con campos internos _shop*), SIN filtrar los
// agotados (a diferencia de /api/products). No reusa applyStockFilter a propósito.
async function loadFeedProducts(env) {
  if (env.SHOPIFY_ADMIN_TOKEN) {
    try {
      const data = await adminGET(env, "/products.json?limit=250&status=active");
      return { source: "admin", products: (data.products || []).map(mapAdminProduct).filter((p) => p.id) };
    } catch (e) { /* probamos Storefront abajo */ }
  }
  if (env.SHOPIFY_STOREFRONT_TOKEN) {
    const q = `{ products(first: 100, sortKey: CREATED_AT, reverse: true) { edges { node {
      id title description productType featuredImage { url } images(first:6){edges{node{url}}}
      variants(first:1){edges{node{ id sku availableForSale price{amount} compareAtPrice{amount} }}} } } } }`;
    const data = await storefront(env, q);
    const edges = (data.data && data.data.products && data.data.products.edges) || [];
    return { source: "storefront", products: edges.map(({ node }) => {
      const v = (node.variants.edges[0] && node.variants.edges[0].node) || {};
      const price = Math.round(Number((v.price && v.price.amount) || 0));
      return {
        id: node.id.split("/").pop(), variantId: v.id ? v.id.split("/").pop() : "", sku: v.sku || "",
        name: node.title, price, image: node.featuredImage ? node.featuredImage.url : "",
        images: ((node.images && node.images.edges) || []).map((e) => e.node.url),
        _shopStock: null, _shopAvail: (typeof v.availableForSale === "boolean" ? v.availableForSale : null),
        category: node.productType || "General", desc: clean(node.description).slice(0, 300),
      };
    }) };
  }
  return { source: "none", products: [] };
}

// Convierte los productos crudos en ítems listos para Meta (filtra los que no
// se pueden anunciar: sin precio o sin foto).
function buildFeedItems(rawProducts, { origin, brand, mode, dropiMap }) {
  const items = [];
  for (const p of rawProducts) {
    if (!p || !p.id) continue;
    const price = Math.round(Number(p.price || 0));
    if (price <= 0) continue;                                  // sin precio => no anunciar
    const image = p.image || (p.images && p.images[0]) || "";
    if (!image) continue;                                      // Meta exige imagen
    const title = String(p.name || "").trim().slice(0, 150);
    let desc = String(p.desc || "").trim();
    if (!desc) desc = (title + (p.category && p.category !== "General" ? " - " + p.category : "")).trim();
    desc = desc.slice(0, 600);
    items.push({
      id: String(p.id),
      title,
      desc,
      availability: feedAvailability(p, mode, dropiMap),
      condition: "new",
      price: price + " PYG",
      link: origin + "/producto.html?id=" + encodeURIComponent(String(p.id)),
      image,
      images: (p.images || []).filter((u) => u && u !== image).slice(0, 10),
      brand,
    });
  }
  return items;
}

function csvCell(s) { return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"'; }
function feedCsv(items) {
  const cols = ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand", "additional_image_link"];
  const rows = [cols.join(",")];
  for (const it of items) {
    rows.push([it.id, it.title, it.desc, it.availability, it.condition, it.price, it.link, it.image, it.brand, it.images.join(",")]
      .map(csvCell).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function feedXml(items, { origin, brand }) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    "<channel>",
    "<title>" + xmlEsc(brand) + "</title>",
    "<link>" + xmlEsc(origin) + "</link>",
    "<description>Catalogo de productos</description>",
  ];
  for (const it of items) {
    out.push("<item>");
    out.push("<g:id>" + xmlEsc(it.id) + "</g:id>");
    out.push("<g:title>" + xmlEsc(it.title) + "</g:title>");
    out.push("<g:description>" + xmlEsc(it.desc) + "</g:description>");
    out.push("<g:availability>" + it.availability + "</g:availability>");
    out.push("<g:condition>" + it.condition + "</g:condition>");
    out.push("<g:price>" + xmlEsc(it.price) + "</g:price>");
    out.push("<g:link>" + xmlEsc(it.link) + "</g:link>");
    out.push("<g:image_link>" + xmlEsc(it.image) + "</g:image_link>");
    out.push("<g:brand>" + xmlEsc(it.brand) + "</g:brand>");
    for (const im of it.images) out.push("<g:additional_image_link>" + xmlEsc(im) + "</g:additional_image_link>");
    out.push("</item>");
  }
  out.push("</channel>", "</rss>");
  return out.join("\n");
}

async function handleFeed(env, url, fmt) {
  if (!env.SHOPIFY_DOMAIN) {
    return new Response("Tienda no configurada (falta SHOPIFY_DOMAIN)", { status: 503, headers: { ...CORS } });
  }
  let load;
  try { load = await loadFeedProducts(env); }
  catch (e) { return new Response("Error leyendo productos: " + String(e), { status: 502, headers: { ...CORS } }); }

  const origin = siteOrigin(env, url), brand = feedBrand(env);
  const mode = (env.STOCK_MODE || "off").toLowerCase();
  let dropiMap = null;
  if (mode === "dropi") { try { dropiMap = await dropiStock(env); } catch (e) { /* Dropi falló => todo in stock */ } }
  const items = buildFeedItems(load.products, { origin, brand, mode, dropiMap });
  const body = fmt === "csv" ? feedCsv(items) : feedXml(items, { origin, brand });
  const ct = fmt === "csv" ? "text/csv; charset=utf-8" : "application/xml; charset=utf-8";
  return new Response(body, { status: 200, headers: {
    "Content-Type": ct,
    "Cache-Control": "public, max-age=" + FEED_MAX_AGE,
    "X-Feed-Count": String(items.length),
    "X-Feed-Source": load.source,
    ...CORS,
  } });
}

/* --------------- CREAR PEDIDO CONTRA ENTREGA (Admin API) --------------- */
async function handleOrder(env, request) {
  const DOMAIN = env.SHOPIFY_DOMAIN, ADMIN = env.SHOPIFY_ADMIN_TOKEN;
  const VERSION = env.SHOPIFY_API_VERSION || "2024-10";
  if (!DOMAIN || !ADMIN) return json({ ok: false, configured: false, reason: "Falta SHOPIFY_ADMIN_TOKEN" });

  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }
  const name = (b.name || "").trim(), phone = (b.phone || "").trim();
  const address = (b.address || "").trim(), city = (b.city || "").trim(), dept = (b.dept || "").trim();
  const variantId = String(b.variantId || "").replace(/\D/g, "");
  const qty = Math.max(1, Number(b.qty || 1));
  if (name.length < 3 || phone.replace(/\D/g, "").length < 7 || address.length < 5 || !variantId) {
    return json({ ok: false, error: "Datos incompletos" }, 400);
  }
  const parts = name.split(" ");
  const order = { order: {
    line_items: [{ variant_id: Number(variantId), quantity: qty }],
    customer: { first_name: parts[0], last_name: parts.slice(1).join(" ") || ".", phone },
    shipping_address: { first_name: parts[0], last_name: parts.slice(1).join(" ") || ".",
      address1: address, city: city || dept || "Paraguay", province: dept, country: "Paraguay", phone },
    financial_status: "pending", inventory_behaviour: "bypass",
    tags: "landing, contra-entrega", note: "Pedido CONTRA ENTREGA generado desde la landing",
    send_receipt: false, send_fulfillment_receipt: false,
  } };
  try {
    const r = await fetch(`https://${DOMAIN}/admin/api/${VERSION}/orders.json`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": ADMIN },
      body: JSON.stringify(order),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, status: r.status, error: data });
    return json({ ok: true, orderNumber: data.order && (data.order.name || data.order.order_number), id: data.order && data.order.id });
  } catch (err) { return json({ ok: false, error: String(err) }); }
}

// Exports SOLO para tests (Cloudflare usa el default export; estos no molestan).
export { mapAdminProduct, buildFeedItems, feedCsv, feedXml, feedAvailability };
