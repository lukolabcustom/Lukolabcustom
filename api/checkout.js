const https = require("https");

const shippingOptions = {
  north: {
    name: "Spedizione Nord Italia",
    amount: 500
  },
  center: {
    name: "Spedizione Centro Italia",
    amount: 600
  },
  south: {
    name: "Spedizione Sud Italia",
    amount: 700
  },
  islands: {
    name: "Spedizione Sicilia e Sardegna",
    amount: 900
  }
};

function stripeRequest(data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();

    const request = https.request(
      {
        hostname: "api.stripe.com",
        path: "/v1/checkout/sessions",
        method: "POST",
        headers: {
          "Authorization":
            "Basic " +
            Buffer.from(
              process.env.STRIPE_SECRET_KEY + ":"
            ).toString("base64"),

          "Content-Type":
            "application/x-www-form-urlencoded",

          "Content-Length":
            Buffer.byteLength(body)
        }
      },
      response => {
        let result = "";

        response.on("data", chunk => {
          result += chunk;
        });

        response.on("end", () => {
          try {
            const json = JSON.parse(result);

            if (response.statusCode >= 400) {
              return reject(
                new Error(
                  json.error?.message ||
                  "Errore Stripe"
                )
              );
            }

            resolve(json);

          } catch (error) {
            reject(
              new Error(
                "Risposta non valida da Stripe: " +
                result.substring(0, 200)
              )
            );
          }
        });
      }
    );

    request.on("error", reject);

    request.write(body);
    request.end();
  });
}

module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  try {

    const { items, shippingZone } =
      req.body || {};

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        error: "Carrello vuoto"
      });
    }

    const shipping =
      shippingOptions[shippingZone];

    if (!shipping) {
      return res.status(400).json({
        error:
          "Zona di spedizione non valida"
      });
    }

    const params = [];

    let index = 0;

    for (const item of items) {

      const name =
        String(item.name || "").trim();

      const price =
        Number(item.price);

      const quantity =
        Number(
          item.quantity ??
          item.qty ??
          1
        );

      if (
        !name ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          error: "Prodotto non valido"
        });
      }

      params.push([
        `line_items[${index}][price_data][currency]`,
        "eur"
      ]);

      params.push([
        `line_items[${index}][price_data][product_data][name]`,
        name
      ]);

      params.push([
        `line_items[${index}][price_data][unit_amount]`,
        String(Math.round(price * 100))
      ]);

      params.push([
        `line_items[${index}][quantity]`,
        String(quantity)
      ]);

      index++;
    }

    params.push([
      `line_items[${index}][price_data][currency]`,
      "eur"
    ]);

    params.push([
      `line_items[${index}][price_data][product_data][name]`,
      shipping.name
    ]);

    params.push([
      `line_items[${index}][price_data][unit_amount]`,
      String(shipping.amount)
    ]);

    params.push([
      `line_items[${index}][quantity]`,
      "1"
    ]);

    params.push([
      "mode",
      "payment"
    ]);

    params.push([
      "payment_method_types[0]",
      "card"
    ]);

    params.push([
      "shipping_address_collection[allowed_countries][0]",
      "IT"
    ]);

    params.push([
      "phone_number_collection[enabled]",
      "true"
    ]);

    params.push([
      "billing_address_collection",
      "auto"
    ]);

    params.push([
      "customer_creation",
      "always"
    ]);

    params.push([
      "metadata[shippingZone]",
      shippingZone
    ]);

    params.push([
      "success_url",
      `${process.env.PUBLIC_URL}/?success=1`
    ]);

    params.push([
      "cancel_url",
      `${process.env.PUBLIC_URL}/?cancel=1`
    ]);

    const session =
      await stripeRequest(params);

    return res.status(200).json({
      url: session.url
    });

  } catch (error) {

    console.error(
      "CHECKOUT ERROR:",
      error
    );

    return res.status(500).json({
      error:
        "Impossibile creare il pagamento"
    });
  }
};
