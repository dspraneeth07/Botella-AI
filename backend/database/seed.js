const { createDatabase } = require('./schema');

function seed() {
  const db = createDatabase();

  // Clear existing data
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for (const t of tables) {
    db.exec(`DELETE FROM "${t.name}"`);
  }

  // --- STORES ---
  const stores = [
    [1, 'Downtown Spirits', '123 Main St', 'Springfield', 'IL', '555-0101'],
    [2, 'Westside Liquor', '456 Oak Ave', 'Springfield', 'IL', '555-0102'],
    [3, 'Northend Wine & Spirits', '789 Pine Rd', 'Springfield', 'IL', '555-0103'],
  ];
  const insStr = db.prepare('INSERT INTO STR VALUES (?,?,?,?,?,?)');
  for (const s of stores) insStr.run(...s);

  // --- CATEGORIES ---
  const categories = [
    [1,'Bourbon'],[2,'Vodka'],[3,'Tequila'],[4,'Scotch'],[5,'Gin'],
    [6,'Rum'],[7,'Wine Red'],[8,'Wine White'],[9,'Beer Craft'],[10,'Beer Domestic'],
    [11,'Whiskey'],[12,'Brandy'],[13,'Liqueur'],[14,'Ready-to-Drink'],[15,'Champagne'],
  ];
  const insCat = db.prepare('INSERT INTO CAT VALUES (?,?)');
  for (const c of categories) insCat.run(...c);

  // --- TYPES ---
  const types = [
    [1,'Domestic Whiskey',25,22,20,18,30,27,25,22,375,750,1000,1750],
    [2,'Imported Spirits',30,27,25,22,35,32,30,27,375,750,1000,1750],
    [3,'Wine',35,30,28,25,40,35,32,28,375,750,1500,3000],
    [4,'Beer',20,18,15,12,25,22,20,15,355,473,650,1000],
    [5,'Premium Spirits',28,25,23,20,33,30,28,25,375,750,1000,1750],
  ];
  const insTyp = db.prepare('INSERT INTO TYP VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const t of types) insTyp.run(...t);

  // --- SIZES ---
  const sizes = [[50,'Miniature'],[200,'Half Pint'],[375,'Pint'],[473,'Tall Can'],[750,'Fifth'],[1000,'Liter'],[1750,'Handle'],[3000,'Box Wine']];
  const insSiz = db.prepare('INSERT INTO SIZ VALUES (?,?)');
  for (const s of sizes) insSiz.run(...s);

  // --- TAX CODES ---
  db.prepare('INSERT INTO TXC VALUES (?,?,?)').run('A','Standard Sales Tax',0.0825);
  db.prepare('INSERT INTO TXC VALUES (?,?,?)').run('B','Reduced Tax',0.05);
  db.prepare('INSERT INTO TXC VALUES (?,?,?)').run('X','Tax Exempt',0);

  // --- EMPLOYEES ---
  const employees = [
    [1,'Mike Johnson','Cashier'],[2,'Sarah Williams','Cashier'],[3,'Tom Brown','Cashier'],
    [4,'Lisa Davis','Manager'],[5,'James Wilson','Cashier'],[6,'Amy Chen','Cashier'],
  ];
  const insEmp = db.prepare('INSERT INTO EMP VALUES (?,?,?)');
  for (const e of employees) insEmp.run(...e);

  // --- VENDORS ---
  const vendors = [
    [1,'Southern Wine & Spirits','','555-1001',12450.00],
    [2,'Republic National','','555-1002',8320.50],
    [3,'Breakthru Beverage','','555-1003',15680.75],
    [4,'RNDC Distribution','','555-1004',6890.25],
    [5,'Midwest Wine Co','','555-1005',4210.00],
    [6,'Craft Beer Direct','','555-1006',3150.80],
    [7,'Premium Imports LLC','','555-1007',9870.00],
    [8,'Valley Spirits Dist','','555-1008',7230.50],
  ];
  const insVnd = db.prepare('INSERT INTO VND VALUES (?,?,?,?,?)');
  for (const v of vendors) insVnd.run(...v);

  // --- PRODUCTS (INV) ---
  const products = [
    [1001,'Jack Daniels 750','Jack Daniels Old No. 7 750ml',1,1,750,18.50,18.75,29.99,30,28,4520.00,48750.00,155,1680,1695.00,18290.00,8.2],
    [1002,'Makers Mark 750','Makers Mark Bourbon 750ml',1,1,750,22.00,22.00,34.99,30,28,3890.00,42100.00,115,1240,1499.00,16200.00,6.5],
    [1003,'Crown Royal 750','Crown Royal Canadian 750ml',11,1,750,19.80,20.10,31.99,28,26,5100.00,55080.00,165,1782,2010.00,21720.00,9.1],
    [1004,'Titos Vodka 1750','Titos Handmade Vodka 1750ml',2,1,1750,19.50,19.50,32.99,25,23,8920.00,96360.00,278,3002,3748.00,40490.00,12.3],
    [1005,'Grey Goose 750','Grey Goose Vodka 750ml',2,2,750,24.50,24.50,39.99,30,28,3200.00,34560.00,82,886,1271.00,13730.00,5.8],
    [1006,'Patron Silver 750','Patron Silver Tequila 750ml',3,2,750,32.00,32.50,49.99,28,26,2850.00,30780.00,58,626,1044.00,11270.00,4.2],
    [1007,'Johnnie Walker Black','Johnnie Walker Black Label 750ml',4,2,750,28.00,28.00,42.99,25,23,2100.00,22680.00,50,540,750.00,8100.00,3.8],
    [1008,'Hendricks Gin 750','Hendricks Gin 750ml',5,2,750,26.50,26.50,39.99,28,26,1680.00,18144.00,43,464,581.00,6270.00,4.1],
    [1009,'Captain Morgan 1750','Captain Morgan Spiced Rum 1750ml',6,1,1750,16.00,16.00,27.99,25,23,4350.00,46980.00,160,1728,1916.00,20690.00,10.5],
    [1010,'Josh Cabernet 750','Josh Cellars Cabernet Sauvignon 750ml',7,3,750,8.50,8.50,14.99,35,32,2890.00,31212.00,198,2138,1288.00,13910.00,15.2],
    [1011,'Kim Crawford SB 750','Kim Crawford Sauvignon Blanc 750ml',8,3,750,9.20,9.20,15.99,35,32,2450.00,26460.00,158,1706,1078.00,11640.00,12.8],
    [1012,'Blue Moon 6pk','Blue Moon Belgian White 6-Pack',9,4,473,7.80,7.80,12.99,20,18,1890.00,20412.00,150,1620,780.00,8424.00,11.0],
    [1013,'Bud Light 30pk','Bud Light 30-Pack Cans',10,4,355,18.50,18.50,27.99,15,13,6780.00,73224.00,248,2678,2356.00,25440.00,18.5],
    [1014,'Jameson 750','Jameson Irish Whiskey 750ml',11,2,750,20.50,20.50,32.99,28,26,3450.00,37260.00,108,1166,1350.00,14580.00,7.2],
    [1015,'Hennessy VS 750','Hennessy VS Cognac 750ml',12,2,750,30.00,30.50,46.99,25,23,4100.00,44280.00,89,961,1511.00,16320.00,5.1],
    [1016,'Baileys Irish 750','Baileys Irish Cream 750ml',13,2,750,18.50,18.50,29.99,28,26,1560.00,16848.00,54,583,621.00,6710.00,4.5],
    [1017,'White Claw Variety','White Claw Hard Seltzer Variety 12pk',14,4,355,14.00,14.00,21.99,18,16,5670.00,61236.00,262,2830,2091.00,22580.00,19.2],
    [1018,'Veuve Clicquot 750','Veuve Clicquot Yellow Label 750ml',15,2,750,42.00,42.00,59.99,22,20,1200.00,12960.00,21,227,378.00,4080.00,2.1],
    [1019,'Fireball 750','Fireball Cinnamon Whisky 750ml',11,1,750,11.00,11.00,18.99,30,28,3890.00,42012.00,210,2268,1680.00,18144.00,14.8],
    [1020,'Don Julio 1942','Don Julio 1942 Tequila 750ml',3,5,750,105.00,105.00,159.99,25,23,3200.00,34560.00,21,227,1155.00,12474.00,1.5],
    [1021,'Buffalo Trace 750','Buffalo Trace Bourbon 750ml',1,1,750,20.00,20.50,31.99,28,26,4800.00,51840.00,155,1674,1860.00,20090.00,9.8],
    [1022,'Woodford Rsv 750','Woodford Reserve Bourbon 750ml',1,5,750,28.00,28.00,42.99,25,23,2100.00,22680.00,51,551,765.00,8260.00,3.5],
    [1023,'Casamigos Blanco','Casamigos Blanco Tequila 750ml',3,5,750,35.00,35.00,49.99,22,20,2750.00,29700.00,56,605,840.00,9072.00,3.8],
    [1024,'Smirnoff 1750','Smirnoff Vodka 1750ml',2,1,1750,14.00,14.00,22.99,25,23,3560.00,38448.00,160,1728,1438.00,15530.00,12.0],
    [1025,'Barefoot Chard 1500','Barefoot Chardonnay 1.5L',8,3,1500,6.50,6.50,11.99,35,32,1850.00,19980.00,158,1706,868.00,9374.00,14.5],
    [1026,'Tanqueray 750','Tanqueray London Dry Gin 750ml',5,2,750,18.00,18.00,28.99,28,26,1450.00,15660.00,52,562,572.00,6175.00,4.8],
    [1027,'Bacardi Superior 1750','Bacardi Superior Rum 1750ml',6,1,1750,15.50,15.50,25.99,25,23,2890.00,31212.00,115,1242,1208.00,13046.00,8.8],
    [1028,'Modelo Especial 12pk','Modelo Especial 12-Pack',10,4,355,13.50,13.50,19.99,18,16,4560.00,49248.00,232,2506,1506.00,16265.00,16.2],
    [1029,'Moet Imperial 750','Moet & Chandon Imperial 750ml',15,2,750,38.00,38.00,52.99,22,20,1060.00,11448.00,21,227,315.00,3402.00,1.8],
    [1030,'Evan Williams 1750','Evan Williams Bourbon 1750ml',1,1,1750,15.00,15.00,24.99,25,23,2980.00,32184.00,122,1318,1219.00,13165.00,9.5],
  ];

  const insInv = db.prepare(`INSERT INTO INV (SKU,SNAME,LNAME,CAT,TYPE,ML,ACOST,LCOST,PRICE,SUPROF,SCPROF,
    MTD_DOL,YTD_DOL,MTD_UNITS,YTD_UNITS,MTD_PROF,YTD_PROF,WEEKS) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of products) insInv.run(...p);

  // --- STOCK PER STORE ---
  const insStk = db.prepare(`INSERT INTO STK (SKU,STORE,FLOOR,BACK,SHELF,RSHELF,WEEKS,SWEEKS,SMIN,SORD,
    SHIPPED,KITS,SDATE,LVEND,PVEND,ACOST,MTD_DOL,YTD_DOL,MTD_UNITS,YTD_UNITS,MTD_PROF,YTD_PROF)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const rng = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const today = new Date();

  for (const p of products) {
    const sku = p[0];
    for (const store of [1, 2, 3]) {
      const floor = rng(0, 24);
      const back = rng(0, 18);
      const shelf = rng(6, 12);
      const weeks = +(Math.random() * 12).toFixed(1);
      const sdate = new Date(today - rng(5, 120) * 86400000).toISOString().split('T')[0];
      const mtdDol = +(p[11] * (0.25 + Math.random() * 0.25)).toFixed(2);
      const ytdDol = +(p[12] * (0.25 + Math.random() * 0.25)).toFixed(2);
      const mtdUnits = Math.round(p[13] * (0.25 + Math.random() * 0.25));
      const ytdUnits = Math.round(p[14] * (0.25 + Math.random() * 0.25));
      const mtdProf = +(p[15] * (0.25 + Math.random() * 0.25)).toFixed(2);
      const ytdProf = +(p[16] * (0.25 + Math.random() * 0.25)).toFixed(2);
      insStk.run(sku, store, floor, back, shelf, shelf, weeks, 4, 2, 6,
        rng(0, 3), rng(0, 2), sdate, rng(1, 8), rng(1, 8), p[6],
        mtdDol, ytdDol, mtdUnits, ytdUnits, mtdProf, ytdProf);
    }
  }

  // --- TRANSACTIONS (JNH + JNL) ---
  const insJNH = db.prepare('INSERT INTO JNH (SALE,STORE,DATE,TSTAMP,TOTAL,CASHIER,REGISTER,CUSTOMER,TAXCODE) VALUES (?,?,?,?,?,?,?,?,?)');
  const insJNL = db.prepare('INSERT INTO JNL (SALE,SKU,QTY,PRICE,COST,CAT,DISCOUNT,DCLASS) VALUES (?,?,?,?,?,?,?,?)');

  let saleId = 10000;
  const dclasses = ['', 'LOYALTY', 'SENIOR', 'EMPLOYEE', 'PROMO'];

  for (let dayOffset = 60; dayOffset >= 0; dayOffset--) {
    const d = new Date(today - dayOffset * 86400000);
    const dateStr = d.toISOString().split('T')[0];
    const dow = d.getDay();
    const txnCount = dow === 0 || dow === 6 ? rng(40, 65) : rng(20, 40);

    for (let t = 0; t < txnCount; t++) {
      saleId++;
      const store = stores[rng(0, 2)][0];
      const cashier = rng(1, 6);
      const register = rng(1, 3);
      const hour = rng(10, 21);
      const minute = rng(0, 59);
      const tstamp = `${dateStr} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00`;
      const itemCount = rng(1, 5);
      let total = 0;

      const lineItems = [];
      for (let i = 0; i < itemCount; i++) {
        const prod = products[rng(0, products.length - 1)];
        const qty = rng(1, 3);
        const discount = Math.random() < 0.15 ? +(prod[8] * rng(5, 15) / 100).toFixed(2) : 0;
        const lineTotal = +(prod[8] * qty - discount).toFixed(2);
        total += lineTotal;
        lineItems.push([saleId, prod[0], qty, prod[8], prod[6], prod[3], discount, discount > 0 ? dclasses[rng(1, 4)] : '']);
      }
      total = +total.toFixed(2);
      const customer = Math.random() < 0.2 ? rng(1, 50) : 0;
      insJNH.run(saleId, store, dateStr, tstamp, total, cashier, register, customer, 'A');
      for (const line of lineItems) insJNL.run(...line);
    }
  }

  // --- HISTORY (HST) - weekly aggregates for 52 weeks ---
  const insHST = db.prepare('INSERT INTO HST (SKU,DATE,QTY,PRICE,COST) VALUES (?,?,?,?,?)');
  for (const p of products) {
    for (let w = 52; w >= 0; w--) {
      const d = new Date(today - w * 7 * 86400000);
      const dateStr = d.toISOString().split('T')[0];
      const qty = Math.round(p[13] / 4 * (0.7 + Math.random() * 0.6));
      insHST.run(p[0], dateStr, qty, p[8], p[6]);
    }
  }

  // --- PURCHASE ORDERS ---
  const insPOH = db.prepare('INSERT INTO POH VALUES (?,?,?,?,?,?,?)');
  const insPOD = db.prepare('INSERT INTO POD (PO,SKU,OQTY,COST,PACK,BQTY,CREDITDUE,CREDITPAID,CREDITSTAT,TRANSFER) VALUES (?,?,?,?,?,?,?,?,?,?)');

  for (let po = 5001; po <= 5040; po++) {
    const vendor = rng(1, 8);
    const store = rng(1, 3);
    const ordDate = new Date(today - rng(1, 45) * 86400000).toISOString().split('T')[0];
    const isReceived = Math.random() < 0.6;
    const rcvDate = isReceived ? new Date(today - rng(0, 10) * 86400000).toISOString().split('T')[0] : null;
    const status = isReceived ? 'R' : 'O';
    let total = 0;
    const lineCount = rng(2, 8);
    const lines = [];
    for (let l = 0; l < lineCount; l++) {
      const prod = products[rng(0, products.length - 1)];
      const oqty = rng(6, 48);
      const cost = prod[6];
      const bqty = !isReceived && Math.random() < 0.2 ? rng(1, 6) : 0;
      const creditDue = Math.random() < 0.1 ? +(cost * rng(1, 3)).toFixed(2) : 0;
      const creditPaid = creditDue > 0 && Math.random() < 0.5 ? creditDue : 0;
      const isTransfer = Math.random() < 0.08 ? 1 : 0;
      total += oqty * cost;
      lines.push([po, prod[0], oqty, cost, rng(1, 12), bqty, creditDue, creditPaid, creditPaid > 0 ? 'P' : '', isTransfer]);
    }
    insPOH.run(po, vendor, store, status, +total.toFixed(2), ordDate, rcvDate);
    for (const line of lines) insPOD.run(...line);
  }

  // --- DEALS ---
  const insDLH = db.prepare('INSERT INTO DLH VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insDLD = db.prepare('INSERT INTO DLD (DEAL,SKU,QTYTODATE,QTYONORDER,DISC1,DISC2,DISC3,DISC4,DISC5,INVOICLEVL) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const dealDescs = ['Spring Buy Program','Volume Discount Q1','New Product Launch','Seasonal Push','Year-End Closeout'];
  for (let deal = 1; deal <= 12; deal++) {
    const vendor = rng(1, 8);
    const startOff = rng(-10, 30);
    const startDate = new Date(today.getTime() - startOff * 86400000).toISOString().split('T')[0];
    const stopDate = new Date(today.getTime() + rng(5, 60) * 86400000).toISOString().split('T')[0];
    insDLH.run(deal, vendor, startDate, stopDate, 25, 50, 100, 200, 500, dealDescs[rng(0, 4)]);
    const skuCount = rng(2, 5);
    for (let s = 0; s < skuCount; s++) {
      const prod = products[rng(0, products.length - 1)];
      insDLD.run(deal, prod[0], rng(10, 80), rng(0, 12), 0.50, 1.00, 1.50, 2.00, 3.00, rng(0, 3));
    }
  }

  // --- PROMOTIONS (SLH + SLL) ---
  const insSLH = db.prepare('INSERT INTO SLH VALUES (?,?,?,?,?)');
  const insSLL = db.prepare('INSERT INTO SLL (SALELIST,SKU,PRICE,COST,PREVPRICE,PREVQTY,SALES,PROFIT,UNITS,ONSALE) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const promos = [
    [1, 'February Specials', 'A', '2026-02-01', '2026-02-28'],
    [2, 'Weekend Warriors', 'A', '2026-02-20', '2026-03-05'],
    [3, 'St Patricks Prep', 'A', '2026-02-15', '2026-03-17'],
    [4, 'January Clearance', 'C', '2026-01-01', '2026-01-31'],
  ];
  for (const p of promos) insSLH.run(...p);
  for (const promo of promos) {
    const count = rng(4, 8);
    for (let i = 0; i < count; i++) {
      const prod = products[rng(0, products.length - 1)];
      const salePrice = +(prod[8] * (0.8 + Math.random() * 0.1)).toFixed(2);
      const units = rng(20, 120);
      const sales = +(salePrice * units).toFixed(2);
      const profit = +((salePrice - prod[6]) * units).toFixed(2);
      insSLL.run(promo[0], prod[0], salePrice, prod[6], prod[8], rng(10, 60), sales, profit, units, promo[2] === 'A' ? 1 : 0);
    }
  }

  // --- PRICE CHANGE LOG ---
  const insPrclog = db.prepare('INSERT INTO PRCLOG (SKU,PRICE,OLDPRICE,TSTAMP,WHO) VALUES (?,?,?,?,?)');
  const staffNames = ['Mike J','Sarah W','Lisa D','Tom B'];
  for (let i = 0; i < 40; i++) {
    const prod = products[rng(0, products.length - 1)];
    const d = new Date(today - rng(1, 90) * 86400000);
    const tstamp = d.toISOString().replace('T', ' ').substring(0, 19);
    const oldPrice = prod[8];
    const newPrice = +(oldPrice * (0.85 + Math.random() * 0.3)).toFixed(2);
    insPrclog.run(prod[0], newPrice, oldPrice, tstamp, staffNames[rng(0, 3)]);
  }

  // --- CUSTOMERS ---
  const insCus = db.prepare('INSERT INTO CUS VALUES (?,?,?,?,?,?,?,?,?,?)');
  const firstNames = ['John','Jane','Bob','Alice','Charlie','Diana','Frank','Grace','Henry','Iris',
    'Kevin','Laura','Mike','Nancy','Oscar','Pam','Quinn','Rosa','Steve','Tina',
    'Ulysses','Vera','Walter','Xena','Yuri','Zara','Alan','Beth','Carl','Donna',
    'Erik','Fiona','Greg','Helen','Ivan','Julia','Ken','Linda','Mark','Nina',
    'Owen','Pat','Ray','Sue','Tim','Uma','Vince','Wendy','Xavier','Yvette'];
  const lastNames = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
    'Anderson','Taylor','Thomas','Hernandez','Moore','Martin','Jackson','Thompson','White','Lopez',
    'Lee','Clark','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott',
    'Green','Baker','Adams','Nelson','Hill','Campbell','Mitchell','Roberts','Carter','Phillips',
    'Evans','Turner','Torres','Parker','Collins','Edwards','Stewart','Morris','Murphy','Cook'];
  const clubTypes = ['', 'GOLD', 'SILVER', 'PLATINUM', ''];
  for (let c = 1; c <= 50; c++) {
    const balance = Math.random() < 0.3 ? +(Math.random() * 800).toFixed(2) : 0;
    const crdLimit = [250, 500, 1000, 2000][rng(0, 3)];
    const club = clubTypes[rng(0, 4)];
    const clubDisc = club === 'PLATINUM' ? 10 : club === 'GOLD' ? 7 : club === 'SILVER' ? 5 : 0;
    const hasWS = Math.random() < 0.1;
    const wsExpire = hasWS ? new Date(today.getTime() + rng(-30, 180) * 86400000).toISOString().split('T')[0] : '';
    insCus.run(c, firstNames[c - 1], lastNames[c - 1], `555-${String(2000 + c).padStart(4, '0')}`,
      balance, crdLimit, club, clubDisc, hasWS ? `WS-${1000 + c}` : '', wsExpire);
  }

  // --- CUSTOMER ORDERS ---
  const insOHD = db.prepare('INSERT INTO OHD VALUES (?,?,?,?,?)');
  const insODD = db.prepare('INSERT INTO ODD (ORDNUM,SKU,QTY,PRICE,AGEDATE) VALUES (?,?,?,?,?)');
  const ordStatuses = ['O', 'O', 'P', 'C', 'C', 'O', 'P'];
  for (let o = 1; o <= 25; o++) {
    const cust = rng(1, 50);
    const status = ordStatuses[rng(0, 6)];
    const ageDate = new Date(today - rng(1, 45) * 86400000).toISOString().split('T')[0];
    const lineCount = rng(1, 4);
    let total = 0;
    const lines = [];
    for (let l = 0; l < lineCount; l++) {
      const prod = products[rng(0, products.length - 1)];
      const qty = rng(1, 6);
      total += prod[8] * qty;
      lines.push([o, prod[0], qty, prod[8], ageDate]);
    }
    insOHD.run(o, cust, status, +total.toFixed(2), ageDate);
    for (const line of lines) insODD.run(...line);
  }

  // --- BAD CHECKS ---
  const insCHH = db.prepare('INSERT INTO CHH VALUES (?,?)');
  const insCHD = db.prepare('INSERT INTO CHD (CHECKID,STATUS,CHK_AMT,DATE) VALUES (?,?,?,?)');
  for (let ch = 1; ch <= 8; ch++) {
    insCHH.run(ch, rng(1, 50));
    const status = Math.random() < 0.4 ? 'P' : 'O';
    const amt = +(rng(25, 250) + Math.random()).toFixed(2);
    const d = new Date(today - rng(5, 90) * 86400000).toISOString().split('T')[0];
    insCHD.run(ch, status, amt, d);
  }

  // --- DRAWER PICKUPS ---
  const insPickup = db.prepare('INSERT INTO PICKUP (REGISTER,CASHIER,CAT,DESCRIPT,AMOUNT,PICKUP,DATE) VALUES (?,?,?,?,?,?,?)');
  const payTypes = [['CASH','Cash Payments'],['CREDIT','Credit Card'],['DEBIT','Debit Card'],['CHECK','Personal Check']];
  for (let dayOff = 30; dayOff >= 0; dayOff--) {
    const d = new Date(today - dayOff * 86400000).toISOString().split('T')[0];
    for (let reg = 1; reg <= 3; reg++) {
      for (const pt of payTypes) {
        const base = pt[0] === 'CASH' ? rng(800, 2500) : pt[0] === 'CREDIT' ? rng(2000, 5000) : pt[0] === 'DEBIT' ? rng(500, 1500) : rng(50, 300);
        const amount = +(base + Math.random() * 100).toFixed(2);
        const pickup = pt[0] === 'CASH' ? +(amount + (Math.random() < 0.1 ? rng(-15, 15) : 0)).toFixed(2) : amount;
        insPickup.run(reg, rng(1, 6), pt[0], pt[1], amount, pickup, d);
      }
    }
  }

  // --- GL ACCOUNTS ---
  const insGLA = db.prepare('INSERT INTO GLA VALUES (?,?,?,?)');
  const glAccounts = [
    ['1000','Cash on Hand',45890.50,'A'],['1100','Accounts Receivable',12450.00,'A'],
    ['1200','Inventory Asset',285000.00,'A'],['1300','Prepaid Expenses',3200.00,'A'],
    ['2000','Accounts Payable',67890.75,'L'],['2100','Sales Tax Payable',8920.30,'L'],
    ['2200','Accrued Expenses',4500.00,'L'],['3000','Owner Equity',180000.00,'E'],
    ['4000','Sales Revenue',892450.00,'R'],['4100','Cost of Goods Sold',580000.00,'X'],
    ['5000','Payroll Expense',125000.00,'X'],['5100','Rent Expense',48000.00,'X'],
    ['5200','Utilities',12600.00,'X'],['5300','Insurance',8400.00,'X'],
  ];
  for (const a of glAccounts) insGLA.run(...a);

  // --- GL MONTHLY BUCKETS ---
  const insGLB = db.prepare('INSERT INTO GLB (GLACCOUNT,DATE,LAMOUNT,RAMOUNT) VALUES (?,?,?,?)');
  for (const acct of glAccounts) {
    for (let m = 11; m >= 0; m--) {
      const d = new Date(today.getFullYear(), today.getMonth() - m, 1).toISOString().split('T')[0];
      const base = Math.abs(acct[2]) / 12;
      const lamt = +(base * (0.8 + Math.random() * 0.4)).toFixed(2);
      const ramt = +(base * (0.8 + Math.random() * 0.4)).toFixed(2);
      insGLB.run(acct[0], d, lamt, ramt);
    }
  }

  // --- TRANSACTION JOURNAL ---
  const insTRN = db.prepare('INSERT INTO TRN (SOURCE,GLACCOUNT,LAMOUNT,RAMOUNT,TDATE,DESCRIPTION) VALUES (?,?,?,?,?,?)');
  const sources = ['SALE','PO','ADJ','PAY','TAX'];
  for (let i = 0; i < 100; i++) {
    const d = new Date(today - rng(0, 60) * 86400000).toISOString().split('T')[0];
    const src = sources[rng(0, 4)];
    const acct = glAccounts[rng(0, glAccounts.length - 1)];
    const amt = +(rng(50, 5000) + Math.random()).toFixed(2);
    insTRN.run(src, acct[0], amt, 0, d, `${src} transaction`);
  }

  // --- UPC CODES ---
  const insUPC = db.prepare('INSERT INTO UPC VALUES (?,?,?)');
  for (const p of products) {
    if (Math.random() < 0.9) {
      const upc = `0${rng(10000, 99999)}${rng(10000, 99999)}${rng(0, 9)}`;
      const lastScanned = Math.random() < 0.8 ? new Date(today - rng(0, 60) * 86400000).toISOString().split('T')[0] : null;
      insUPC.run(upc, p[0], lastScanned);
    }
  }

  // --- VENDOR BEST REFERENCES ---
  const insVBR = db.prepare('INSERT INTO VBR VALUES (?,?,?,?,?)');
  for (const p of products) {
    const v1 = rng(1, 8);
    let v2 = rng(1, 8);
    while (v2 === v1) v2 = rng(1, 8);
    insVBR.run(p[0], p[6], v1, +(p[6] * 1.05).toFixed(2), v2);
  }

  // --- VENDOR PRICING HISTORY ---
  const insVPR = db.prepare('INSERT INTO VPR (SKU,VEND,BESTBOT,DATE) VALUES (?,?,?,?)');
  for (const p of products) {
    for (let m = 5; m >= 0; m--) {
      const d = new Date(today.getFullYear(), today.getMonth() - m, 1).toISOString().split('T')[0];
      const price = +(p[6] * (0.95 + Math.random() * 0.1)).toFixed(2);
      insVPR.run(p[0], rng(1, 8), price, d);
    }
  }

  // --- PHYSICAL COUNTS ---
  const insHND = db.prepare('INSERT INTO HND (SKU,STORE,FLOOR,BACK,COUNTDATE) VALUES (?,?,?,?,?)');
  for (const p of products) {
    for (const store of [1, 2, 3]) {
      if (Math.random() < 0.4) {
        const d = new Date(today - rng(1, 30) * 86400000).toISOString().split('T')[0];
        insHND.run(p[0], store, rng(0, 20), rng(0, 15), d);
      }
    }
  }

  // --- KITS ---
  const insKIT = db.prepare('INSERT INTO KIT (SKU,KSKU,QTY) VALUES (?,?,?)');
  insKIT.run(1001, 1019, 1); // Jack + Fireball combo
  insKIT.run(1001, 1012, 2); // Jack + Blue Moon
  insKIT.run(1006, 1023, 1); // Patron + Casamigos

  // --- TAX STAMPS ---
  const insStamps = db.prepare('INSERT INTO STAMPS (SERIES,QTY,SNUMBER,ENUMBER,DATE) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 10; i++) {
    const series = `TS-2026-${String(i + 1).padStart(3, '0')}`;
    const start = rng(100000, 999999);
    const qty = rng(100, 500);
    const d = new Date(today - rng(0, 90) * 86400000).toISOString().split('T')[0];
    insStamps.run(series, qty, start, start + qty - 1, d);
  }

  // --- DEPOSITS ---
  const insDep = db.prepare('INSERT INTO DEP VALUES (?,?,?)');
  for (const p of products) {
    if ([9, 10, 14].includes(p[3])) {
      insDep.run(p[0], 0.05, 0.60);
    }
  }

  db.close();
  console.log('Database seeded successfully with realistic liquor store data!');
}

seed();
