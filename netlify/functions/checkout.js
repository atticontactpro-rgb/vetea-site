// Fonction de paiement Vétéa : crée une page de paiement Stripe Checkout à partir du panier.
// Prix et livraison sont recalculés ici (jamais ceux envoyés par le navigateur).
// Réglage : dans Netlify > Site configuration > Environment variables, ajoute STRIPE_SECRET_KEY.
// Aucune dépendance : on parle directement à l'API Stripe.

// encode un objet en paramètres "a[b][0][c]=..." comme l'attend l'API Stripe
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}
async function createSession(params) {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: encode(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message || "Stripe");
  return data;
}

const SIZES = ["XS", "S", "M", "L", "XL"];
const PIECES = { sweat: "Sweat à capuche", jogging: "Jogging", tshirt: "T-shirt" };
const OFFERS = {
  sweat:    { name: "Sweat à capuche Ink Spirit",        price: 85,  pieces: ["sweat"] },
  jogging:  { name: "Jogging Ink Spirit",                price: 79,  pieces: ["jogging"] },
  tshirt:   { name: "T-shirt Ink Spirit",                price: 45,  pieces: ["tshirt"] },
  ensemble: { name: "Ensemble Ink Spirit (sweat + jogging)", price: 149, pieces: ["sweat", "jogging"], bundle: true },
  packJT:   { name: "Jogging + t-shirt Ink Spirit",      price: 105, pieces: ["jogging", "tshirt"], bundle: true },
  look:     { name: "Look complet Ink Spirit",           price: 179, pieces: ["sweat", "jogging", "tshirt"], bundle: true }
};
const SHIPPING = 490;   // en centimes
const FREE_FROM = 100;  // en euros

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };
  const site = process.env.URL || `https://${event.headers.host}`;
  let items;
  try { items = JSON.parse(event.body).items; } catch { return json(400, { error: "Panier illisible" }); }
  if (!Array.isArray(items) || !items.length || items.length > 20) return json(400, { error: "Panier vide" });

  const line_items = [], summary = [];
  let subtotal = 0, hasBundle = false;
  for (const it of items) {
    const o = OFFERS[it.id];
    const qty = Math.floor(Number(it.qty));
    if (!o || !Array.isArray(it.sizes) || it.sizes.length !== o.pieces.length || !it.sizes.every(s => SIZES.includes(s)) || !(qty >= 1 && qty <= 10))
      return json(400, { error: "Article invalide" });
    const sizes = o.pieces.map((p, k) => `${PIECES[p]} ${it.sizes[k]}`).join(", ");
    line_items.push({
      quantity: qty,
      price_data: { currency: "eur", unit_amount: o.price * 100, product_data: { name: o.name, description: `Taille : ${sizes}` } }
    });
    summary.push(`${qty}x ${o.name} (${sizes})`);
    subtotal += o.price * qty;
    if (o.bundle) hasBundle = true;
  }
  const free = hasBundle || subtotal >= FREE_FROM;

  let session;
  try { session = await createSession({
    mode: "payment",
    line_items,
    locale: "fr",
    allow_promotion_codes: "true",
    shipping_address_collection: { allowed_countries: ["FR"] },
    shipping_options: [{ shipping_rate_data: {
      type: "fixed_amount", display_name: free ? "Livraison offerte" : "Livraison suivie",
      fixed_amount: { amount: free ? 0 : SHIPPING, currency: "eur" },
      delivery_estimate: { minimum: { unit: "business_day", value: 3 }, maximum: { unit: "business_day", value: 6 } }
    } }],
    phone_number_collection: { enabled: "true" },
    custom_fields: [
      { key: "prenom", label: { type: "custom", custom: "Prénom pour la lettre" }, type: "text", text: { maximum_length: 24 } },
      { key: "cadeau", label: { type: "custom", custom: "Un petit mot pour la lettre (facultatif)" }, type: "text", optional: "true", text: { maximum_length: 120 } }
    ],
    metadata: { commande: summary.join(" | ").slice(0, 490) },
    payment_intent_data: {
      description: summary.join(" | ").slice(0, 490),
      metadata: { commande: summary.join(" | ").slice(0, 490) }
    },
    success_url: `${site}/merci.html`,
    cancel_url: `${site}/#pieces`
  }); } catch (e) { return json(502, { error: "Le paiement n'a pas pu s'ouvrir. Réessaie dans un instant." }); }
  return json(200, { url: session.url });
};

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
