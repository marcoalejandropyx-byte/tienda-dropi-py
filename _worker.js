/**
 * Cloudflare Pages — Advanced mode ( _worker.js en la raíz )
 * ------------------------------------------------------------------
 * La landing muestra los productos de tu tienda SHOPIFY (sincronizada
 * con Dropi vía Dropify) y permite CERRAR VENTAS contra entrega
 * directo desde la página (crea el pedido en Shopify, sin WhatsApp).
 *
 * Rutas:
 *   GET  /api/products      -> lista productos (Storefront API)
 *   GET  /api/product?id=   -> detalle de un producto (Storefront API)
 *   POST /api/order         -> crea un pedido contra entrega (Admin API)
 *   (otras)                 -> archivos estáticos (index.html, producto.html)
 *
 * Variables de entorno (Cloudflare -> Settings -> Variables and Secrets):
 *   SHOPIFY_DOMAIN            (texto)   ej: 00kv0v-ck.myshopify.com
 *   SHOPIFY_STOREFRONT_TOKEN  (texto)   token público de la Storefront API
 *   SHOPIFY_ADMIN_TOKEN       (SECRETO) token de Admin API (write_orders)
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

async function storefront(env, query, variables) {
  const DOMAIN = env.SHOPIFY_DOMAIN, TOKEN = env.SHOPIFY_STOREFRONT_TOKEN;
  const VERSION = env.SHOPIFY_API_VERSION || "2024-10";
  if (!DOMAIN || !TOKEN) return { _missing: true };
  const r = await fetch(`https://${DOMAIN}/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) return { _error: `HTTP ${r.status}: ${await r.text()}` };
  return r.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/api/products") return handleProducts(env);
    if (url.pathname === "/api/product") return handleProduct(env, url.searchParams.get("id"));
    if (url.pathname === "/api/order" && request.method === "POST") return handleOrder(env, request);
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------ LISTA ------------------------------ */
async function handleProducts(env) {
  const query = `{
    products(first: 50, sortKey: CREATED_AT, reverse: true) {
      edges { node {
        id title description productType
        featuredImage { url }
        variants(first: 1) { edges { node { id price { amount } compareAtPrice { amount } availableForSale } } }
      } }
    }
  }`;
  const data = await storefront(env, query);
  if (data._missing) return json({ ok: false, configured: false, products: [] });
  if (data._error || data.errors) return json({ ok: false, configured: true, error: data._error || data.errors, products: [] });
  const edges = (data.data && data.data.products && data.data.products.edges) || [];
  const products = edges.map(({ node }) => {
    const v = (node.variants.edges[0] && node.variants.edges[0].node) || {};
    const price = Math.round(Number((v.price && v.price.amount) || 0));
    const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
    return {
      id: node.id.split("/").pop(),
      variantId: v.id ? v.id.split("/").pop() : "",
      name: node.title, price, old: compare > price ? compare : Math.round(price * 1.3),
      image: node.featuredImage ? node.featuredImage.url : "",
      stock: v.availableForSale ? 99 : 0,
      category: node.productType || "General",
      desc: (node.description || "").replace(/<[^>]*>/g, "").slice(0, 120), sales: "",
    };
  });
  return json({ ok: true, configured: true, count: products.length, products }, 200, { "Cache-Control": "public, max-age=300" });
}

/* ----------------------------- DETALLE ----------------------------- */
async function handleProduct(env, id) {
  if (!id) return json({ ok: false, error: "Falta id" }, 400);
  const gid = `gid://shopify/Product/${id}`;
  const query = `query($id: ID!) {
    product(id: $id) {
      id title descriptionHtml description productType
      images(first: 8) { edges { node { url } } }
      variants(first: 1) { edges { node { id price { amount } compareAtPrice { amount } availableForSale } } }
    }
  }`;
  const data = await storefront(env, query, { id: gid });
  if (data._missing) return json({ ok: false, configured: false });
  if (data._error || data.errors) return json({ ok: false, configured: true, error: data._error || data.errors });
  const p = data.data && data.data.product;
  if (!p) return json({ ok: false, error: "Producto no encontrado" }, 404);
  const v = (p.variants.edges[0] && p.variants.edges[0].node) || {};
  const price = Math.round(Number((v.price && v.price.amount) || 0));
  const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
  const images = p.images.edges.map((e) => e.node.url);
  return json({
    ok: true, configured: true,
    product: {
      id, variantId: v.id ? v.id.split("/").pop() : "",
      name: p.title, price, old: compare > price ? compare : Math.round(price * 1.3),
      images, image: images[0] || "",
      descHtml: p.descriptionHtml || "", desc: p.description || "",
      category: p.productType || "General", available: !!v.availableForSale,
    },
  }, 200, { "Cache-Control": "public, max-age=300" });
}

/* --------------- CREAR PEDIDO CONTRA ENTREGA (Admin API) --------------- */
async function handleOrder(env, request) {
  const DOMAIN = env.SHOPIFY_DOMAIN, ADMIN = env.SHOPIFY_ADMIN_TOKEN;
  const VERSION = env.SHOPIFY_API_VERSION || "2024-10";
  if (!DOMAIN || !ADMIN) {
    return json({ ok: false, configured: false, reason: "Falta SHOPIFY_ADMIN_TOKEN" });
  }
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }

  const name = (b.name || "").trim();
  const phone = (b.phone || "").trim();
  const address = (b.address || "").trim();
  const city = (b.city || "").trim();
  const dept = (b.dept || "").trim();
  const variantId = String(b.variantId || "").replace(/\D/g, "");
  const qty = Math.max(1, Number(b.qty || 1));

  // Validación mínima anti-pedidos falsos
  if (name.length < 3 || phone.replace(/\D/g, "").length < 7 || address.length < 5 || !variantId) {
    return json({ ok: false, error: "Datos incompletos" }, 400);
  }

  const parts = name.split(" ");
  const order = {
    order: {
      line_items: [{ variant_id: Number(variantId), quantity: qty }],
      customer: { first_name: parts[0], last_name: parts.slice(1).join(" ") || ".", phone },
      shipping_address: {
        first_name: parts[0], last_name: parts.slice(1).join(" ") || ".",
        address1: address, city: city || dept || "Paraguay", province: dept, country: "Paraguay", phone,
      },
      financial_status: "pending",
      inventory_behaviour: "bypass",
      tags: "landing, contra-entrega",
      note: "Pedido CONTRA ENTREGA generado desde la landing",
      send_receipt: false, send_fulfillment_receipt: false,
    },
  };

  try {
    const r = await fetch(`https://${DOMAIN}/admin/api/${VERSION}/orders.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": ADMIN },
      body: JSON.stringify(order),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, status: r.status, error: data });
    return json({ ok: true, orderNumber: data.order && (data.order.name || data.order.order_number), id: data.order && data.order.id });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}
