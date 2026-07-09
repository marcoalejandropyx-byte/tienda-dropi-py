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
  return {
    id: String(p.id),
    variantId: v.id ? String(v.id) : "",
    name: p.title,
    price,
    old: compare > price ? compare : Math.round(price * 1.3),
    image: (p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src) || "",
    images: (p.images || []).map((i) => i.src),
    stock: 99,           // dropshipping: se muestra como Disponible (Dropi maneja el stock)
    available: true,
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
      const products = (data.products || []).map(mapAdminProduct).filter((p) => p.id);
      return json({ ok: true, configured: true, source: "admin", count: products.length, products },
        200, { "Cache-Control": "public, max-age=120" });
    } catch (e) { /* si falla, probamos Storefront abajo */ }
  }

  // Respaldo: Storefront (solo publicados en el canal Headless)
  if (!env.SHOPIFY_STOREFRONT_TOKEN) return json({ ok: false, configured: false, products: [] });
  try {
    const q = `{ products(first: 50, sortKey: CREATED_AT, reverse: true) { edges { node {
      id title description productType featuredImage { url }
      variants(first:1){ edges { node { id price{amount} compareAtPrice{amount} } } } } } } }`;
    const data = await storefront(env, q);
    const edges = (data.data && data.data.products && data.data.products.edges) || [];
    const products = edges.map(({ node }) => {
      const v = (node.variants.edges[0] && node.variants.edges[0].node) || {};
      const price = Math.round(Number((v.price && v.price.amount) || 0));
      const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
      return {
        id: node.id.split("/").pop(), variantId: v.id ? v.id.split("/").pop() : "",
        name: node.title, price, old: compare > price ? compare : Math.round(price * 1.3),
        image: node.featuredImage ? node.featuredImage.url : "",
        stock: 99, available: true, category: node.productType || "General",
        desc: clean(node.description).slice(0, 140), sales: "",
      };
    });
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
      images(first:8){edges{node{url}}} variants(first:1){edges{node{ id price{amount} compareAtPrice{amount} }}} } }`;
    const data = await storefront(env, q, { id: gid });
    const p = data.data && data.data.product;
    if (!p) return json({ ok: false, error: "no encontrado" }, 404);
    const v = (p.variants.edges[0] && p.variants.edges[0].node) || {};
    const price = Math.round(Number((v.price && v.price.amount) || 0));
    const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
    const images = p.images.edges.map((e) => e.node.url);
    return json({ ok: true, configured: true, product: {
      id, variantId: v.id ? v.id.split("/").pop() : "", name: p.title, price,
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
