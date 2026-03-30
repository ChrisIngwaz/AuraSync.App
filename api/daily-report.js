import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import qs from 'qs'; // Usaremos esto para formatear correctamente el envío

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  const {
    AIRTABLE_BASE_ID,
    AIRTABLE_TOKEN,
    AIRTABLE_TABLE_NAME = 'Citas',
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE
  } = process.env;

  const NUMEROS_REPORTE = ['whatsapp:+593995430859']; 

  try {
    const ahora = new Date();
    const hoyEcuador = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    // 1. Obtener citas de hoy
    const formula = `IS_SAME({Fecha}, '${hoyEcuador}', 'day')`;
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];

    if (citas.length === 0) {
      return res.status(200).json({ success: true, message: "Sin citas hoy." });
    }

    // 2. Procesar Balance
    let total = 0;
    const servicios = {};
    const expertos = {};

    citas.forEach(r => {
      const f = r.fields;
      total += parseFloat(f["Importe estimado"] || 0);
      if (f.Servicio) servicios[f.Servicio] = (servicios[f.Servicio] || 0) + 1;
      if (f.Especialista) expertos[f.Especialista] = (expertos[f.Especialista] || 0) + 1;
    });

    const topServicio = Object.keys(servicios).reduce((a, b) => servicios[a] > servicios[b] ? a : b, "N/A");
    const topExperto = Object.keys(expertos).reduce((a, b) => expertos[a] > expertos[b] ? a : b, "N/A");

    // 3. Crear Mensaje
    const fechaTxt = ahora.toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' });
    const mensajeBody = `📊 *Balance Diario AuraSync* - ${fechaTxt}\n` +
      `----------------------------------\n` +
      `✅ *Citas Agendadas:* ${citas.length}\n` +
      `💰 *Ingresos Proyectados:* $${total.toFixed(2)}\n` +
      `💇‍♂️ *Servicio más pedido:* ${topServicio}\n` +
      `⭐ *Especialista del día:* ${topExperto}\n` +
      `----------------------------------\n` +
      `_Generado por Aura._`;

    // 4. Envío Blindado a Twilio
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    
    for (const destino of NUMEROS_REPORTE) {
      // Usamos URLSearchParams para asegurar el formato x-www-form-urlencoded que pide Twilio
      const data = new URLSearchParams();
      data.append('To', destino.trim());
      data.append('From', TWILIO_PHONE.trim());
      data.append('Body', mensajeBody);

      await axios({
        method: 'post',
        url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
        data: data.toString(),
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('DETALLE ERROR:', error.response?.data || error.message);
    return res.status(500).json({ 
      error: "Error en envío", 
      detalle: error.response?.data || error.message 
    });
  }
}
