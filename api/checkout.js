const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const products = {
  "cap-01": { name: "Cappello Luko Lab 01", price: 3500 },
  "cap-02": { name: "Cappello Luko Lab 02", price: 3500 },
  "cap-03": { name: "Cappello Luko Lab 03", price: 3500 },
  "cap-04": { name: "Cappello Luko Lab 04", price: 3500 },
  "cap-05": { name: "Cappello Luko Lab 05", price: 3500 },
  "cap-06": { name: "Cappello Luko Lab 06", price: 3500 },
  "cap-07": { name: "Cappello Luko Lab 07", price: 3500 },
  "cap-08": { name: "Cappello Luko Lab 08", price: 3500 },
  "cap-09": { name: "Cappello Luko Lab 09", price: 3500 },
  "cap-10": { name: "Cappello Luko Lab 10", price: 3500 },
  "cap-11": { name: "Cappello Luko Lab 11", price: 3500 },
  "cap-12": { name: "Cappello Luko Lab 12", price: 3500 },
  "cap-13": { name: "Cappello Luko Lab 13", price: 3500 },
  "cap-14": { name: "Cappello Luko Lab 14", price: 3500 }
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Carrello vuoto" });
    }

    const line_items = items.map((item) => {
      const product = products[item.id];

      if (!product) {
        throw new Error("Prodotto non valido");
      }

      const quantity = Math.max(1, Math.min(10, Number(item.quantity) || 1));

      return {
        price_data: {
          currency: "eur",
          product_data: {
            name: product.name
          },
          unit_amount: product.price
        },
        quantity
      };
    });

    const baseUrl =
      process.env.PUBLIC_URL || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: `${baseUrl}/?pagamento=successo`,
      cancel_url: `${baseUrl}/?pagamento=annullato`
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Impossibile creare il pagamento"
    });
  }
};
