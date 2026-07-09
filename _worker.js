/**
 * Cloudflare Pages — Advanced mode ( _worker.js en la raíz )
 * ------------------------------------------------------------------
 * La landing tienda-dropi.pages.dev muestra los productos que tenés
 * en tu tienda SHOPIFY (que a su vez se sincroniza con Dropi vía la
 * app Dropify). Así la landing y tu tienda muestran el mismo catálogo.
 *
 * Rutas:
 *   GET  /api/products  -> lista productos desde Shopify (Storefront API)
 *   (otras)             -> sirve los archivos estáticos (index.html)
 *
 * Variables de entorno (Cloudflare -> Settings -> Variables and Secrets):
 *   SHOPIFY_DOMAIN            (texto)   ej: 00kv0v-ck.myshopify.com
 *   SHOPIFY_STOREFRONT_TOKEN  (SECRET)  token de la Storefront API
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/api/products") return handleProducts(env);
    return env.ASSETS.fetch(request);
  },
};

async function handleProducts(env) {
  const DOMAIN = env.SHOPIFY_DOMAIN;
  const TOKEN = env.SHOPIFY_STOREFRONT_TOKEN;
  const VERSION = env.SHOPIFY_API_VERSION || "2024-10";

  if (!DOMAIN || !TOKEN) {
    return json({ ok: false, configured: false, reason: "Faltan SHOPIFY_DOMAIN o SHOPIFY_STOREFRONT_TOKEN", products: [] });
  }

  const query = `{
    products(first: 50, sortKey: CREATED_AT, reverse: true) {
      edges { node {
        id
        title
        description
        productType
        featuredImage { url }
        variants(first: 1) { edges { node {
          price { amount currencyCode }
          compareAtPrice { amount }
          availableForSale
          quantityAvailable
        } } }
      } }
    }
  }`;

  try {
    const resp = await fetch(`https://${DOMAIN}/api/${VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      return json({ ok: false, configured: true, status: resp.status, error: await resp.text(), products: [] });
    }

    const data = await resp.json();
    if (data.errors) {
      return json({ ok: false, configured: true, error: data.errors, products: [] });
    }

    const edges = (data.data && data.data.products && data.data.products.edges) || [];
    const products = edges.map(({ node }, i) => {
      const v = (node.variants.edges[0] && node.variants.edges[0].node) || {};
      const price = Math.round(Number((v.price && v.price.amount) || 0));
      const compare = Math.round(Number((v.compareAtPrice && v.compareAtPrice.amount) || 0));
      return {
        id: node.id.split("/").pop(),
        name: node.title,
        price,
        old: compare > price ? compare : Math.round(price * 1.3),
        image: node.featuredImage ? node.featuredImage.url : "",
        stock: v.availableForSale ? (v.quantityAvailable || 99) : 0,
        category: node.productType || "General",
        desc: (node.description || "").replace(/<[^>]*>/g, "").slice(0, 120),
        sales: "",
      };
    });

    return json({ ok: true, configured: true, count: products.length, products },
      200, { "Cache-Control": "public, max-age=300" });
  } catch (err) {
    return json({ ok: false, configured: true, error: String(err), products: [] });
  }
}
