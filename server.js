const express  = require('express');
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const cors      = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SolNergy PDF Service', version: '1.0.0' });
});

app.post('/generate-pdf', async (req, res) => {
  await generateAndSend(req.body, res);
});

app.get('/pdf', async (req, res) => {
  try {
    if (!req.query.data) return res.status(400).send('Veri eksik');
    const data = JSON.parse(Buffer.from(req.query.data, 'base64').toString('utf-8'));
    await generateAndSend(data, res);
  } catch (err) {
    console.error('GET /pdf hata:', err.message);
    res.status(500).send('PDF olusturulamadi: ' + err.message);
  }
});

async function generateAndSend(data, res) {
  if (!data.firstName || !data.lastName || !data.totalIncl) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: await chromium.executablePath(),
      headless:       chromium.headless,
      args:           chromium.args,
    });

    const page = await browser.newPage();
    await page.setContent(buildAngebotHtml(data), {
      waitUntil: 'networkidle0',
      timeout:   30000,
    });

    const pdfBuffer = await page.pdf({
      format:          'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    await browser.close();

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'inline; filename="Angebot_' + (data.angebotNr || 'ANG') + '_' + data.lastName + '.pdf"',
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-cache',
    });
    res.send(pdfBuffer);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('PDF hatasi:', err.message);
    res.status(500).json({ error: 'PDF Generierung fehlgeschlagen', detail: err.message });
  }
}

function buildAngebotHtml(d) {
  const brutto      = parseFloat(d.totalIncl) || 0;
  const netto       = brutto / 1.19;
  const mwst        = brutto - netto;
  const foerder     = parseFloat(d.foerderSumme) || 0;
  const eigenanteil = brutto - foerder;
  const fmt = function(n) { return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  const FIRMA_NAME    = 'SolNergy GmbH';
  const FIRMA_ADRESSE = 'Bahnhofstrasse 92, 82166 Grafelfing';
  const FIRMA_TEL     = '08131 77 99 473';
  const FIRMA_MAIL    = 'info@solnergy.solar';
  const FIRMA_WEB     = 'www.solnergy.solar';

  const agreementLabels = {
    '22143': 'inkl. SG Ready Schnittstelle-PV/WP (Aufputz/bis 5m)',
    '22142': 'inkl. Aufstellort Aussen bis 2m - ab 2m je Meter 250 EUR',
    '22141': 'inkl. Erdung 2x je 10m, falls nicht vorhanden',
    '22140': 'inkl. zwei Heizkreise (Fussbodenheizung/Heizkoerper)',
    '22139': 'inkl. Fussbodenheizkreisverteiler Austausch',
    '22138': 'inkl. Niedertemperaturheizkoerper mit Kuhlfunktion je Heizkoerper',
    '22137': 'inkl. Heizkoerpertausch je Heizkoerper gemass Heizlastberechnung',
    '22135': 'inkl. Solarthermie-Anbindung',
    '22134': 'inkl. Unterverteilung fuer 2. Stromzahler (WP-Tarif)',
    '22133': 'inkl. 14A Schrank (APZ & RFZ Feld)',
    '22114': 'KfW-Ablehnungsklausel: Kostenfrei bei Ablehnung',
    '22049': 'inkl. neuem separaten 2-Zahlerfeld Aufputz Zahlerschrank',
    '22048': 'inkl. Ausbau und Entsorgung des Oltanks',
    '22044': 'inkl. neuem separaten 4-Zahlerfeld Aufputz Zahlerschrank',
    '22043': 'inkl. neuem separaten 3-Zahlerfeld Aufputz Zahlerschrank',
  };

  var agreementsHtml = (d.agreements || [])
    .map(function(v) { return '<tr><td style="padding:5px 0;font-size:12px;border-bottom:1px solid #f0ede6">+ ' + (agreementLabels[v] || v) + '</td></tr>'; })
    .join('');

  return '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><style>' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'body{font-family:Arial,sans-serif;color:#1a1a1a;background:#fff;font-size:13px;line-height:1.5}' +
    '.page{padding:40px 48px}' +
    '.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:18px;border-bottom:2.5px solid #E8A000}' +
    '.logo{font-size:28px;font-weight:700;color:#E8A000}' +
    '.logo span{color:#1a1a1a}' +
    '.logo-sub{font-size:9px;color:#aaa;text-transform:uppercase;margin-top:2px}' +
    '.header-right{text-align:right;font-size:11px;color:#666;line-height:1.8}' +
    '.recipient{display:inline-block;background:#F7F6F3;border-radius:8px;padding:14px 18px;margin-bottom:20px}' +
    '.recipient .name{font-size:14px;font-weight:600;margin-bottom:3px}' +
    '.recipient .addr{font-size:12px;color:#555;line-height:1.7}' +
    '.badge{display:inline-block;background:#E8A000;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;margin-bottom:6px}' +
    '.anr-title{font-size:20px;font-weight:700;margin-bottom:3px}' +
    '.anr-date{font-size:11px;color:#aaa;margin-bottom:18px}' +
    '.intro{font-size:13px;color:#444;line-height:1.75;margin-bottom:22px}' +
    '.sec{font-size:10px;font-weight:700;color:#E8A000;letter-spacing:0.9px;text-transform:uppercase;margin:20px 0 10px;padding-bottom:5px;border-bottom:1px solid #FFF3D6}' +
    '.tgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:18px}' +
    '.titem{background:#F7F6F3;border-radius:6px;padding:9px 12px}' +
    '.tlabel{font-size:9px;color:#aaa;text-transform:uppercase;margin-bottom:2px}' +
    '.tval{font-size:12px;font-weight:600}' +
    'table.pos{width:100%;border-collapse:collapse;margin-bottom:18px}' +
    'table.pos th{background:#1a1a1a;color:#fff;padding:7px 10px;text-align:left;font-size:10px}' +
    'table.pos td{padding:8px 10px;border-bottom:1px solid #f0ede6;vertical-align:top}' +
    'table.pos tr:nth-child(even) td{background:#FAFAF8}' +
    '.pn{width:32px;font-weight:700;color:#E8A000;font-size:12px}' +
    '.pt{font-weight:600;margin-bottom:2px;font-size:12px}' +
    '.pd{font-size:11px;color:#777;line-height:1.5}' +
    'table.zahl{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12px}' +
    'table.zahl td{padding:6px 0;border-bottom:1px solid #f0ede6}' +
    'table.zahl td:last-child{text-align:right;font-weight:600}' +
    '.pricebox{background:#1a1a1a;border-radius:10px;padding:18px 22px;margin-bottom:18px}' +
    '.prow{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:rgba(255,255,255,0.55)}' +
    '.prow.main{border-top:1px solid rgba(255,255,255,0.12);margin-top:7px;padding-top:11px;font-size:16px;color:#fff;font-weight:700}' +
    '.prow.fo{color:#E8A000;font-weight:700;font-size:13px}' +
    '.prow.eg{color:#1D9E75;font-weight:700;font-size:13px}' +
    '.sig-line{width:200px;border-top:1px solid #1a1a1a;margin:28px 0 5px}' +
    '.sig-label{font-size:10px;color:#aaa}' +
    '.footer{margin-top:24px;padding-top:14px;border-top:1px solid #e0ddd5;font-size:10px;color:#aaa;line-height:1.8}' +
    '.disclaimer{margin-top:8px;padding-top:8px;border-top:1px solid #f0ede6;font-size:9.5px;color:#bbb;line-height:1.7}' +
    '</style></head><body><div class="page">' +

    '<div class="header"><div><div class="logo">Sol<span>Nergy</span></div><div class="logo-sub">Ihr Spezialist fuer Erneuerbare Energien</div></div>' +
    '<div class="header-right">' + FIRMA_ADRESSE + '<br>Tel: ' + FIRMA_TEL + '<br>' + FIRMA_MAIL + ' | ' + FIRMA_WEB + '</div></div>' +

    '<div class="recipient"><div class="name">' + d.salutation + ' ' + d.firstName + ' ' + d.lastName + (d.companyName ? ' / ' + d.companyName : '') + '</div>' +
    '<div class="addr">' + d.street + ' ' + d.houseNumber + ' - ' + d.zip + ' ' + d.city + '<br>' +
    d.phoneNumber + (d.mobileNumber ? ' - ' + d.mobileNumber : '') + '<br>' + d.emailAddress + '</div></div>' +

    '<div class="badge">Waermepumpen Angebot</div>' +
    '<div class="anr-title">Ihr persoenliches Angebot ' + (d.angebotNr || '') + '</div>' +
    '<div class="anr-date">Erstellt am ' + (d.date || new Date().toLocaleDateString('de-DE')) + '</div>' +

    '<p class="intro">Sehr geehrte' + (d.salutation === 'Frau' ? '' : 'r') + ' ' + d.salutation + ' ' + d.lastName + ',<br><br>' +
    'wir freuen uns, Ihnen heute das Angebot fuer Ihre Waermepumpe zusenden zu koennen. Gerne stehen wir Ihnen jederzeit zur Verfuegung.</p>' +

    '<div class="sec">Technische Eckdaten</div>' +
    '<div class="tgrid">' +
    '<div class="titem"><div class="tlabel">Wohnflaeche</div><div class="tval">' + (d.wohnflaeche || '-') + ' m2</div></div>' +
    '<div class="titem"><div class="tlabel">Baujahr</div><div class="tval">' + (d.baujahr || '-') + '</div></div>' +
    '<div class="titem"><div class="tlabel">Heizkoerper</div><div class="tval">' + (d.heizkoerper || '-') + '</div></div>' +
    '<div class="titem"><div class="tlabel">Heizenergieart</div><div class="tval">' + (d.heizenergieart || '-') + '</div></div>' +
    '<div class="titem"><div class="tlabel">Verbrauch/Jahr</div><div class="tval">' + (d.energy ? parseInt(d.energy).toLocaleString('de-DE') + ' kWh' : '-') + '</div></div>' +
    '<div class="titem"><div class="tlabel">Heizkosten/Jahr</div><div class="tval">' + (d.kwhprice ? parseFloat(d.kwhprice).toLocaleString('de-DE', {minimumFractionDigits:2}) + ' EUR' : '-') + '</div></div>' +
    '</div>' +

    '<div class="sec">Leistungsuebersicht</div>' +
    '<table class="pos"><thead><tr><th class="pn">POS</th><th>Bezeichnung</th></tr></thead><tbody>' +
    '<tr><td class="pn">1</td><td><div class="pt">Waermepumpen Aussengeraet</div><div class="pd">' + (d.moduleName || d.module || '-') + ' - R290 - Vorlauftemperatur bis 70 Grad - Foerderfaehig nach BEG</div></td></tr>' +
    '<tr><td class="pn">2</td><td><div class="pt">Waermepumpen Inneneinheit</div><div class="pd">Kompakte Inneneinheit inkl. Umwaelzpumpe, Umschaltventil und Sicherheitsarmaturen</div></td></tr>' +
    '<tr><td class="pn">3</td><td><div class="pt">Hochleistungs-Pufferspeicher 75L</div><div class="pd">Max. 3 bar - bis 110 Grad - Vliesdaemmung</div></td></tr>' +
    '<tr><td class="pn">4</td><td><div class="pt">Hochleistungs-Hygienespeicher 300L</div><div class="pd">Max. 10 bar - Max. 95 Grad - El. Zusatzheizung 3kW - Klasse A+++</div></td></tr>' +
    '<tr><td class="pn">5</td><td><div class="pt">Elektrische Zusatzheizung</div><div class="pd">Bis 9 kW - Automatischer Zuschaltbetrieb - Foerderfaehig nach BEG</div></td></tr>' +
    '<tr><td class="pn">6</td><td><div class="pt">Verrohrungssystem</div><div class="pd">Gemass GEG - Druckpruefung und Dichtheitsnachweis</div></td></tr>' +
    '<tr><td class="pn">7</td><td><div class="pt">Demontage Altanlage & Montage Neuanlage</div><div class="pd">Fachgerechte Stilllegung - Aufstellung und Einbindung Waermepumpe</div></td></tr>' +
    '<tr><td class="pn">8</td><td><div class="pt">Projektierung - Planung & technische Auslegung</div><div class="pd">Heizlastberechnung DIN EN 12831 - Hydraulikschema - Foerderunterstuetzung</div></td></tr>' +
    '<tr><td class="pn">9</td><td><div class="pt">Foerdermittel - Unterstuetzung & Abwicklung</div><div class="pd">BEG EM ueber KfW - Optimale Foerderoption - Vollstaendige Abwicklung</div></td></tr>' +
    '<tr><td class="pn">10</td><td><div class="pt">Anmeldung und Fertigmeldung beim Netzbetreiber</div><div class="pd">EVU-Anmeldung - Betriebsschaltbild - Pruefprotokoll</div></td></tr>' +
    '<tr><td class="pn">11</td><td><div class="pt">Elektroinstallation Anschluss & Steuerung</div><div class="pd">Fachgerechte Verlegung - FI-Schalter - Eingetragener Elektrofachbetrieb</div></td></tr>' +
    '<tr><td class="pn">12</td><td><div class="pt">Erstinbetriebnahme gemass Herstellervorgaben</div><div class="pd">Druckpruefung - Parametrierung - Einweisung des Betreibers</div></td></tr>' +
    '<tr><td class="pn">13</td><td><div class="pt">Hydraulischer Abgleich - Verfahren B (VdZ)</div><div class="pd">VdZ-Nachweis - Voraussetzung fuer BEG EM Foerderung</div></td></tr>' +
    '<tr><td class="pn">14</td><td><div class="pt">Technischer Support</div><div class="pd">Hersteller & SolNergy Service-Team</div></td></tr>' +
    '<tr><td class="pn">15</td><td><div class="pt">SolNergy Garantieversprechen</div><div class="pd">Bestpreisgarantie - Festpreisgarantie - 100% Kaeufer schutz - Keine Vorkasse</div></td></tr>' +
    '</tbody></table>' +

    (agreementsHtml ? '<div class="sec">Zusatzvereinbarungen</div><table style="width:100%;border-collapse:collapse;margin-bottom:18px"><tbody>' + agreementsHtml + '</tbody></table>' : '') +

    '<div class="sec">Zahlungsmodalitaeten</div>' +
    '<table class="zahl">' +
    '<tr><td>1. Abschlag, 80%, bei Warenlieferung</td><td>' + fmt(brutto * 0.8) + ' EUR</td></tr>' +
    '<tr><td>2. Abschlag, 20%, bei Inbetriebnahme</td><td>' + fmt(brutto * 0.2) + ' EUR</td></tr>' +
    '</table>' +

    '<div class="pricebox">' +
    '<div class="prow"><span>Gesamtsumme Netto</span><span>' + fmt(netto) + ' EUR</span></div>' +
    '<div class="prow"><span>19% MwSt.</span><span>' + fmt(mwst) + ' EUR</span></div>' +
    '<div class="prow main"><span>Gesamtsumme Brutto</span><span>' + fmt(brutto) + ' EUR</span></div>' +
    (foerder > 0 ? '<div class="prow fo"><span>Foerdersumme (' + (d.heatingcosts || '') + '%)</span><span>' + fmt(foerder) + ' EUR</span></div>' +
    '<div class="prow eg"><span>Eigenanteil nach Foerderung</span><span>' + fmt(eigenanteil) + ' EUR</span></div>' : '') +
    '</div>' +

    '<p style="font-size:12px;color:#555;line-height:1.7;margin-bottom:18px">Hiermit nehme ich das Angebot vom ' +
    (d.date || new Date().toLocaleDateString('de-DE')) + ' an und beauftrage die ' + FIRMA_NAME + ' zur Durchfuehrung meines Projektes.</p>' +
    '<div class="sig-line"></div>' +
    '<div class="sig-label">Ort, Datum, Unterschrift - ' + d.salutation + ' ' + d.firstName + ' ' + d.lastName + '</div>' +

    '<div class="footer"><strong>' + FIRMA_NAME + '</strong> - ' + FIRMA_ADRESSE + ' - Tel: ' + FIRMA_TEL + ' - ' + FIRMA_MAIL + '<br>' +
    'Steuernummer: 143/181/60458 - HRB 279588 Amtsgericht Muenchen - Geschaeftsfuehrer: Eren Yakisikli<br>' +
    'IBAN: DE08 7019 0000 0003 1477 54 - BIC: GENODEF1M01</div>' +
    '<div class="disclaimer">Die staatlichen Foerdermittel sind nicht Bestandteil dieses Angebots. Muendliche Abmachungen sind nicht Bestandteil des Vertrags.</div>' +

    '</div></body></html>';
}

app.listen(PORT, function() {
  console.log('SolNergy PDF Service running on port ' + PORT);
});
