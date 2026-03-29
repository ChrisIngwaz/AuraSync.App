import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE: process.env.TWILIO_PHONE, // Formato 'whatsapp:+123456789'
  NUMEROS_REPORTE: ['whatsapp:+593995430859', 'whatsapp:+593995163184'] // Dueño y Admin
};

export default async function handler(req, res) {
  // Solo permitir ejecución si es una petición autorizada (Cron de Vercel)
  // Opcional: if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) ...

  try {
    const ahora = new Date();
    const hoyEcuador = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }); // YYYY-MM-DD

    // 1. Obtener citas de hoy desde Airtable
    const formula = `IS_SAME({Fecha}, '${hoyEcuador}', 'day')`;
    const airtableUrl = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}`;
    
    const response = await axios.get(airtableUrl, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const citas = response.data.records;

    if (citas.length === 0) {
      return res.status(200).json({ message: "No hubo citas hoy para reportar." });
    }

    // 2. Procesar Datos (Balance)
    let totalIngresos = 0;
    const serviciosCount = {};
    const especialistasCount = {};

    citas.forEach(record => {
      const f = record.fields;
      totalIngresos += parseFloat(f["Importe estimado"] || 0);
      
      serviciosCount[f.Servicio] = (serviciosCount[f.Servicio] || 0) + 1;
      especialistasCount[f.Especialista] = (especialistasCount[f.Especialista] || 0) + 1;
    });

    const servicioMasPedido = Object.keys(serviciosCount).reduce((a, b) => serviciosCount[a] > serviciosCount[b] ? a : b);
    const topEspecialista = Object.keys(especialistasCount).reduce((a, b) => especialistasCount[a] > especialistasCount[b] ? a : b);

    // 3. Formatear Mensaje
    const fechaFormateada = ahora.toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' });
    const mensaje = `📊 *Balance Diario AuraSync* - ${fechaFormateada}\n` +
      `----------------------------------\n` +
      `✅ *Citas Agendadas:* ${citas.length}\n` +
      `💰 *Ingresos Proyectados:* $${totalIngresos.toFixed(2)}\n` +
      `💇‍♂️ *Servicio más pedido:* ${servicioMasPedido}\n` +
      `⭐ *Especialista del día:* ${topEspecialista} (${especialistasCount[topEspecialista]} citas)\n` +
      `----------------------------------\n` +
      `_Reporte generado automáticamente por Aura._`;

    // 4. Enviar vía Twilio a cada número
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');

    for (const numero de CONFIG.NUMEROS_REPORTE) {
      const params = new URLSearchParams();
      params.append('To', numero);
      params.append('From', CONFIG.TWILIO_PHONE);
      params.append('Body', mensaje);

      await axios.post(twilioUrl, params, {
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    }

    return res.status(200).json({ success: true, message: "Reporte enviado." });

  } catch (error) {
    console.error('Error en reporte:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
