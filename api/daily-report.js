import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  // Configuración interna directa para evitar errores de inicialización
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Citas';
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_PHONE = process.env.TWILIO_PHONE;
  const NUMEROS_REPORTE = ['whatsapp:+593995430859']; 

  try {
    const ahora = new Date();
    // Fecha hoy en formato YYYY-MM-DD para Ecuador
    const hoyEcuador = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    // 1. Obtener citas de hoy desde Airtable
    const formula = `IS_SAME({Fecha}, '${hoyEcuador}', 'day')`;
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(formula)}`;
    
    const response = await axios.get(airtableUrl, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    const citas = response.data.records || [];

    if (citas.length === 0) {
      return res.status(200).json({ success: true, message: "No hay citas hoy." });
    }

    // 2. Procesar Datos
    let totalIngresos = 0;
    const serviciosCount = {};
    const especialistasCount = {};

    citas.forEach(record => {
      const f = record.fields;
      totalIngresos += parseFloat(f["Importe estimado"] || 0);
      if (f.Servicio) serviciosCount[f.Servicio] = (serviciosCount[f.Servicio] || 0) + 1;
      if (f.Especialista) especialistasCount[f.Especialista] = (especialistasCount[f.Especialista] || 0) + 1;
    });

    const servicioMasPedido = Object.keys(serviciosCount).length > 0 
      ? Object.keys(serviciosCount).reduce((a, b) => serviciosCount[a] > serviciosCount[b] ? a : b) 
      : "N/A";
    
    const topEspecialista = Object.keys(especialistasCount).length > 0 
      ? Object.keys(especialistasCount).reduce((a, b) => especialistasCount[a] > especialistasCount[b] ? a : b) 
      : "N/A";

    // 3. Formatear Mensaje
    const fechaTexto = ahora.toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' });
    const mensaje = `📊 *Balance Diario AuraSync* - ${fechaTexto}\n` +
      `----------------------------------\n` +
      `✅ *Citas Agendadas:* ${citas.length}\n` +
      `💰 *Ingresos Proyectados:* $${totalIngresos.toFixed(2)}\n` +
      `💇‍♂️ *Servicio más pedido:* ${servicioMasPedido}\n` +
      `⭐ *Especialista del día:* ${topEspecialista}\n` +
      `----------------------------------\n` +
      `_Reporte generado automáticamente por Aura._`;

    // 4. Enviar vía Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    for (const numero of NUMEROS_REPORTE) {
      const params = new URLSearchParams();
      params.append('To', numero);
      params.append('From', TWILIO_PHONE);
      params.append('Body', mensaje);

      await axios.post(twilioUrl, params, {
        headers: { 
          'Authorization': `Basic ${auth}`, 
          'Content-Type': 'application/x-www-form-urlencoded' 
        }
      });
    }

    return res.status(200).json({ success: true, count: citas.length });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return res.status(500).json({ error: error.message });
  }
}
