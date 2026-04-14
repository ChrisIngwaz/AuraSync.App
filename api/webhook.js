import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONEXIÓN A BASES DE DATOS ---
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

const TIMEZONE = 'America/Guayaquil';

// --- HERRAMIENTAS DE FECHA ---

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parts.find(p => p.type === 'year')?.value || '2026';
  const month = parts.find(p => p.type === 'month')?.value || '1';
  const day = parts.find(p => p.type === 'day')?.value || '1';
  const fecha = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO;
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// --- LÓGICA DE AGENDA REAL ---

async function obtenerCitasOcupadasAirtable(fechas) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const formula = `OR(${fechas.map(f => `{Fecha} = '${f}'`).join(',')})`;
    const filter = encodeURIComponent(`AND(${formula}, {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    return response.data.records.map(r => ({ fecha: r.fields.Fecha, hora: r.fields.Hora, especialista: r.fields.Especialista, servicio: r.fields.Servicio }));
  } catch (error) { return []; }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialista, duracion) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    const citas = response.data.records;
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracion || 60);
    
    for (const cita of citas) {
      const [he, me] = cita.fields.Hora.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + (cita.fields['Duración estimada (minutos)'] || 60);
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialista || cita.fields.Especialista === especialista) return { ok: false };
      }
    }
    return { ok: true, especialista: especialista || 'Asignar' };
  } catch (error) { return { ok: true }; }
}

// --- ACCIONES (AGENDAR, CANCELAR, REAGENDAR) ---

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    await axios.post(url, { records: [{ fields: { "Cliente": `${datos.nombre} ${datos.apellido}`.trim(), "Servicio": datos.servicio, "Fecha": fechaUTC, "Hora": datos.hora, "Especialista": datos.especialista, "Teléfono": datos.telefono, "Estado": "Confirmada", "Importe estimado": datos.precio, "Duración estimada (minutos)": datos.duracion, "ID_Supabase": datos.supabase_id } }] }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return true;
  } catch (error) { return false; }
}

async function cancelarCitaAirtable(telefono, citaId) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    if (busqueda.data.records.length === 0) return false;
    const record = busqueda.data.records[0];
    await axios.patch(url, { records: [{ id: record.id, fields: { "Estado": "Cancelada" } }] }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    if (record.fields.ID_Supabase) await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', record.fields.ID_Supabase);
    return true;
  } catch (error) { return false; }
}

async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    if (busqueda.data.records.length === 0) return false;
    const record = busqueda.data.records[0];
    const [h, min] = datos.cita_hora.split(':').map(Number);
    const [anio, mes, dia] = datos.cita_fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    await axios.patch(url, { records: [{ id: record.id, fields: { "Fecha": fechaUTC, "Hora": datos.cita_hora } }] }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    if (record.fields.ID_Supabase) await supabase.from('citas').update({ fecha_hora: `${datos.cita_fecha}T${datos.cita_hora}:00-05:00` }).eq('id', record.fields.ID_Supabase);
    return true;
  } catch (error) { return false; }
}

// --- SERVIDOR Y WEBHOOK ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/api/whatsapp', async (req, res) => {
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';
 
  try {
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` } });
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

    const fechaHoy = getFechaEcuador(0);
    const fechaManana = getFechaEcuador(1);
    const ocupadas = await obtenerCitasOcupadasAirtable([fechaHoy, fechaManana]);
    const agendaTexto = ocupadas.map(c => `- ${c.fecha} ${c.hora} con ${c.especialista}`).join('\n') || "Libre";

    const systemPrompt = `Eres Aura, asistente de lujo. Tono: Humano, cálido y elegante.
[AGENDA OCUPADA - NO OFRECER]
${agendaTexto}
[ESPECIALISTAS]
${especialistas?.map(e => `${e.nombre}: ${e.expertise}`).join(', ')}
[SERVICIOS]
${servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ')}
[REGLA]
1. Descubre qué quiere. 2. Propón UN horario. 3. Confirma solo si acepta.
DATA_JSON:{"accion":"none","nombre":"","cita_fecha":"","cita_hora":"","cita_servicio":"","cita_especialista":""}`;

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', { model: "gpt-4o", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: textoUsuario }], temperature: 0.3 }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` } });
    let reply = aiRes.data.choices[0].message.content;
    
    const jsonMatch = reply.match(/\{.*\}/s);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      if (data.accion === 'agendar') {
        const serv = servicios.find(s => s.nombre.toLowerCase().includes(data.cita_servicio.toLowerCase()));
        const disp = await verificarDisponibilidadAirtable(data.cita_fecha, data.cita_hora, data.cita_especialista, serv?.duracion);
        if (disp.ok) {
          const { data: newCita } = await supabase.from('citas').insert({ cliente_id: cliente?.id, fecha_hora: `${data.cita_fecha}T${data.cita_hora}:00-05:00`, estado: 'Confirmada' }).select().single();
          await crearCitaAirtable({ ...data, telefono: userPhone, precio: serv?.precio, duracion: serv?.duracion, supabase_id: newCita?.id });
          reply = reply.split('DATA_JSON')[0] + "\n\n✅ Cita confirmada.";
        } else { reply = "Ese horario se acaba de ocupar, ¿buscamos otro?"; }
      } else if (data.accion === 'cancelar') { await cancelarCitaAirtable(userPhone); reply = reply.split('DATA_JSON')[0] + "\n\n✅ Cita cancelada."; }
      else if (data.accion === 'reagendar') { await reagendarCitaAirtable(userPhone, data); reply = reply.split('DATA_JSON')[0] + "\n\n✅ Cita cambiada."; }
    }

    res.setHeader('Content-Type', 'text/xml');
    res.send(`<Response><Message>${reply.split('DATA_JSON')[0]}</Message></Response>`);
  } catch (err) { res.status(200).send('<Response><Message>Error, intenta de nuevo.</Message></Response>'); }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (req, res) => res.sendFile(path.join(process.cwd(), 'dist', 'index.html')));
  }
  app.listen(3000, "0.0.0.0");
}
startServer();
export default app;
