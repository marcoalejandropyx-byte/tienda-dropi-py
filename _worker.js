/**
 * Cloudflare Pages — Advanced mode ( _worker.js en la raíz )
 * ------------------------------------------------------------------
 * La landing muestra los productos de tu tienda SHOPIFY (sincronizada
 * con Dropi vía Dropify). Cada producto tiene además su propia página.
 *
 * Rutas:
 *   GET  /api/products      -> lista productos (Storefront API)
 *   GET  /api/product?id=   -> detalle completo de un producto
 *   (otras)                 -> archivos estáticos (index.html, producto.html)
 *
 * Variables de entorno:
 *   SHOPIFY_DOMAIN            (texto)   ej: 00kv0v-ck.myshopify.com
 *   SHOPIFY_STOREFRONT_TOKEN  (secreto) token de la Storefront API
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
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

async function shopify(env, query, variables) {
  const DOMAIN = env.SHOPIFY_DOMAIN;
  const TOKEN = env.SHOPIFY_STOREFRONT_TOKEN;
  const VERSION = env.SHOPIFY_API_VERSION || "2024-10";
  if (!DOMAIN || !TOKEN) return { _missing: true };
  const resp = await fetch(`https://${DOMAIN}/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) return { _error: `HTTP ${resp.status}: ${await resp.text()}` };
  return resp.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/api/products") return handleProducts(env);
    if (url.pathname === "/api/product") return handleProduct(env, url.searchParams.get("id"));
    return env.ASSETS.fetch(request);
  },
};

/* --------------------------- LISTA --------------------------- */
async function handleProducts(env) {
  const query = `{
    products(first: 50, sortKey: CREATED_AT, reverse: true) {
      edges { node {
        id title description productType
        featuredImage { url }
        variants(first: 1) { edges { node {
          price { amount currencyCode }
          compareAtPrice { amount }
          availableForSale
        } } }
      } }
    }
  }`;
  const data = await shopify(env, query);
  if (data._missing) return json({ ok: false, configured: false, reason: "Faltan variables de Shopify", products: [] });
  if (data._error) return json({ ok: false, configured: true, error: data._error, products: [] });
  if (data.errors) return json({ ok: false, configured: true, error: data.errors, products: [] });

  const edges = (data.data && data.data.products && data.data.products.edges) || [];
  const products = edges.map(({ node }) => {
    const v = (node.variants.edges[0] && node.variants.edges[0].node) || {};
    const price = Math.round(Number((v.price && v.price.amount) || 0));
    const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
    return {
      id: node.id.split("/").pop(),
      name: node.title,
      price,
      old: compare > price ? compare : Math.round(price * 1.3),
      image: node.featuredImage ? node.featuredImage.url : "",
      stock: v.availableForSale ? 99 : 0,
      category: node.productType || "General",
      desc: (node.description || "").replace(/<[^>]*>/g, "").slice(0, 120),
      sales: "",
    };
  });
  return json({ ok: true, configured: true, count: products.length, products },
    200, { "Cache-Control": "public, max-age=300" });
}

/* --------------------------- DETALLE --------------------------- */
async function handleProduct(env, id) {
  if (!id) return json({ ok: false, error: "Falta id" }, 400);
  const gid = `gid://shopify/Product/${id}`;
  const query = `query($id: ID!) {
    product(id: $id) {
      id title descriptionHtml description productType
      images(first: 8) { edges { node { url } } }
      variants(first: 1) { edges { node {
        price { amount currencyCode }
        compareAtPrice { amount }
        availableForSale
      } } }
    }
  }`;
  const data = await shopify(env, query, { id: gid });
  if (data._missing) return json({ ok: false, configured: false });
  if (data._error) return json({ ok: false, configured: true, error: data._error });
  if (data.errors) return json({ ok: false, configured: true, error: data.errors });

  const p = data.data && data.data.product;
  if (!p) return json({ ok: false, error: "Producto no encontrado" }, 404);
  const v = (p.variants.edges[0] && p.variants.edges[0].node) || {};
  const price = Math.round(Number((v.price && v.price.amount) || 0));
  const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
  const images = p.images.edges.map((e) => e.node.url);

  return json({
    ok: true, configured: true,
    product: {
      id, name: p.title, price,
      old: compare > price ? compare : Math.round(price * 1.3),
      images,
      image: images[0] || "",
      descHtml: p.descriptionHtml || "",
      desc: p.description || "",
      category: p.productType || "General",
      available: !!v.availableForSale,
    },
  }, 200, { "Cache-Control": "public, max-age=300" });
}
