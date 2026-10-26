

<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Luko Lab Custom - Admin</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:20px;background:#101713;color:#f4f4f4;font-family:Arial,sans-serif}
main{max-width:760px;margin:auto}
h1,h2{color:#c4ff70}
.panel{background:#1b2820;border:1px solid #35483a;border-radius:12px;padding:20px;margin-bottom:20px}
label{display:block;margin:14px 0 6px}
input,select,button{width:100%;padding:12px;border-radius:7px;border:1px solid #536455;font-size:16px}
input,select{background:#101713;color:white}
button{margin-top:15px;border:0;background:#c4ff70;color:#101713;font-weight:bold;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
.secondary{background:#35483a;color:white}
.danger{background:#a92f38;color:white}
.stock-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.product{display:flex;gap:12px;align-items:center;border-top:1px solid #35483a;padding:14px 0}
.product img{width:76px;height:76px;object-fit:cover;border-radius:8px}
.product-info{flex:1;min-width:0}
.product-info p{margin:5px 0;overflow-wrap:anywhere}
.product-info button{width:auto;margin:5px 0 0}
#message{white-space:pre-wrap;overflow-wrap:anywhere}
[hidden]{display:none!important}
@media(max-width:480px){body{padding:12px}.panel{padding:14px}.product{align-items:flex-start}.product img{width:62px;height:62px}}
</style>
</head>
<body>
<main>
<h1>LUKO LAB CUSTOM</h1>
<p>Gestione prodotti e disponibilità.</p>

<section id="loginPanel" class="panel">
<h2>Accesso amministratore</h2>
<form id="loginForm">
<label for="password">Password amministratore</label>
<input id="password" type="password" autocomplete="current-password" required>
<button id="loginButton" type="submit">Accedi</button>
</form>
</section>

<section id="adminPanel" hidden>
<div class="panel">
<h2>Aggiungi prodotto</h2>
<form id="productForm">
<label for="productName">Nome prodotto</label>
<input id="productName" required maxlength="120">

<label for="productPrice">Prezzo (€)</label>
<input id="productPrice" type="number" min="0.01" step="0.01" value="35" required>

<label for="productCategory">Categoria</label>
<select id="productCategory" required>
<option value="Cappelli">Cappelli</option>
<option value="Abbigliamento">Abbigliamento</option>
</select>

<h3>Quantità disponibili per taglia</h3>
<p>Inserisci quanti pezzi hai in magazzino.</p>
<div class="stock-grid">
<div>
<label for="stockS">Taglia S</label>
<input id="stockS" type="number" min="0" max="100000" step="1" value="0" required>
</div>
<div>
<label for="stockM">Taglia M</label>
<input id="stockM" type="number" min="0" max="100000" step="1" value="0" required>
</div>
</div>

<label for="productImage">Foto prodotto</label>
<input id="productImage" type="file" accept="image/jpeg,image/png,image/webp" required>

<button id="publishButton" type="submit">Pubblica prodotto</button>
</form>
</div>

<div class="panel">
<h2>Prodotti pubblicati</h2>
<button id="refreshButton" class="secondary" type="button">Aggiorna elenco</button>
<div id="productsList">Caricamento prodotti...</div>
</div>

<button id="logoutButton" class="secondary" type="button">Esci dall'amministrazione</button>
</section>
<p id="message" role="status"></p>
</main>

<script>
const $ = id => document.getElementById(id);

function showMessage(message){
  $("message").textContent=message;
}

async function api(url,options={}){
  const response=await fetch(url,{
    ...options,
    headers:{
      ...(options.body?{"Content-Type":"application/json"}:{}),
      ...(options.headers||{})
    }
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||"Errore nella richiesta.");
  return data;
}

$("loginForm").addEventListener("submit",async event=>{
  event.preventDefault();
  const button=$("loginButton");
  button.disabled=true;
  showMessage("Accesso in corso...");
  try{
    await api("/api/admin-login",{
      method:"POST",
      body:JSON.stringify({password:$("password").value})
    });
    $("loginPanel").hidden=true;
    $("adminPanel").hidden=false;
    $("password").value="";
    await loadProducts();
    showMessage("Accesso effettuato.");
  }catch(error){
    showMessage(error.message);
  }finally{
    button.disabled=false;
  }
});

function compressImage(file){
  return new Promise((resolve,reject)=>{
    const image=new Image();
    const objectUrl=URL.createObjectURL(file);
    image.onload=()=>{
      try{
        const canvas=document.createElement("canvas");
        const scale=Math.min(1,1600/Math.max(image.width,image.height));
        canvas.width=Math.round(image.width*scale);
        canvas.height=Math.round(image.height*scale);
        canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob=>{
          URL.revokeObjectURL(objectUrl);
          if(!blob) return reject(new Error("Impossibile elaborare la foto."));
          resolve(blob);
        },"image/jpeg",0.82);
      }catch(error){
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror=()=>{
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Impossibile leggere la foto."));
    };
    image.src=objectUrl;
  });
}

function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(",")[1]);
    reader.onerror=()=>reject(new Error("Impossibile preparare la foto."));
    reader.readAsDataURL(blob);
  });
}

$("productForm").addEventListener("submit",async event=>{
  event.preventDefault();

  const button=$("publishButton");
  const file=$("productImage").files[0];
  const name=$("productName").value.trim();
  const price=Number($("productPrice").value);
  const category=$("productCategory").value;
  const stockS=Number($("stockS").value);
  const stockM=Number($("stockM").value);

  if(!name||!file){
    showMessage("Inserisci il nome e seleziona una foto.");
    return;
  }
  if(!Number.isFinite(price)||price<=0){
    showMessage("Inserisci un prezzo valido.");
    return;
  }
  if(!Number.isInteger(stockS)||stockS<0||stockS>100000||
     !Number.isInteger(stockM)||stockM<0||stockM>100000){
    showMessage("Le quantità devono essere numeri interi tra 0 e 100000.");
    return;
  }
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){
    showMessage("Usa una foto JPG, PNG o WEBP.");
    return;
  }

  button.disabled=true;
  showMessage("Caricamento foto e pubblicazione in corso...");

  try{
    const compressed=await compressImage(file);
    const base64=await blobToBase64(compressed);

    const uploaded=await api("/api/upload",{
      method:"POST",
      body:JSON.stringify({
        filename:file.name,
        contentType:"image/jpeg",
        data:base64
      })
    });

    if(!uploaded.url) throw new Error("Il caricamento della foto non ha restituito un URL.");

    await api("/api/products",{
      method:"POST",
      body:JSON.stringify({
        name,
        price,
        category,
        image:uploaded.url,
        stock:{S:stockS,M:stockM}
      })
    });

    $("productForm").reset();
    $("productPrice").value="35";
    $("stockS").value="0";
    $("stockM").value="0";

    await loadProducts();
    showMessage("Prodotto pubblicato correttamente.");
  }catch(error){
    showMessage("Pubblicazione non completata: "+error.message);
  }finally{
    button.disabled=false;
  }
});

async function loadProducts(){
  const container=$("productsList");
  container.textContent="Caricamento prodotti...";

  try{
    const data=await api("/api/products?cache="+Date.now());
    container.replaceChildren();

    if(!Array.isArray(data.products)||data.products.length===0){
      container.textContent="Nessun prodotto presente.";
      return;
    }

    for(const product of data.products){
      const card=document.createElement("div");
      card.className="product";

      if(product.image){
        const image=document.createElement("img");
        image.src=product.image;
        image.alt=product.name||"Prodotto";
        image.loading="lazy";
        card.appendChild(image);
      }

      const info=document.createElement("div");
      info.className="product-info";

      const name=document.createElement("strong");
      name.textContent=product.name||"Prodotto";

      const details=document.createElement("p");
      details.textContent="€"+Number(product.price).toFixed(2)+" · "+(product.category||"");

      const stock=product.stock||{S:0,M:0};
      const quantities=document.createElement("p");
      quantities.textContent="Taglia S: "+Number(stock.S||0)+" · Taglia M: "+Number(stock.M||0);

      const remove=document.createElement("button");
      remove.className="danger";
      remove.type="button";
      remove.textContent="Elimina";

      remove.addEventListener("click",async()=>{
        if(!confirm("Vuoi eliminare questo prodotto?")) return;
        remove.disabled=true;
        try{
          await api("/api/products",{
            method:"DELETE",
            body:JSON.stringify({id:product.id})
          });
          await loadProducts();
          showMessage("Prodotto eliminato.");
        }catch(error){
          showMessage(error.message);
          remove.disabled=false;
        }
      });

      info.append(name,details,quantities,remove);
      card.appendChild(info);
      container.appendChild(card);
    }
  }catch(error){
    container.textContent="Errore: "+error.message;
  }
}

$("refreshButton").addEventListener("click",loadProducts);
$("logoutButton").addEventListener("click",()=>location.reload());
</script>
</body>
</html>
