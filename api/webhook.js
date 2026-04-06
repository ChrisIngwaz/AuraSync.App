import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Inicialización de Clientes
console.log('🔑 Verificando llaves maestras...');
console.log('- Supabase URL:', process.env.SUPABASE_URL ? '✅ OK' : '❌ FALTANTE');
console.log('- Twilio SID:', process.env.TWILIO_ACCOUNT_SID ? '✅ OK' : '❌ FALTANTE');
console.log('- OpenAI Key:', process.env.OPENAI_API_KEY ? '✅ OK' : '❌ FALTANTE');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER
};

const twilioClient = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);
const { MessagingResponse } = twilio.twiml;

// ============ UTILIDADES DE TIEMPO ============

function timeToMinutes(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * VERIFICA DISPONIBILIDAD
 */
async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
    if (!especialistaId || especialistaId === '...' || especialistaId === 'Asignar') {
      return { disponible: true, mensaje: null };
    }

    const inicioNueva = timeToMinutes(hora);
    const finNueva = inicioNueva + duracionMinutos;
    const HORA_APERTURA = 540;  // 9:00
    const HORA_CIERRE = 1080;   // 18:00

    if (inicioNueva < HORA_APERTURA || finNueva > HORA_CIERRE) {
      return { 
        disponible: false, 
        mensaje: `Nuestro horario de atención es de 9:00 a 18:00. ¿Te parece bien otro momento?` 
      };
    }

    const { data: citasExistentes, error } = await supabase
      .from('citas')
      .select('fecha_hora, duracion_aux, servicio_aux')
      .eq('especialista_id', especialistaId)
      .eq('fecha_hora::date', fecha) 
      .in('estado', ['Confirmada', 'En proceso']);

    if (error) throw error;

    for (const cita of citasExistentes || []) {
      const horaExistente = cita.fecha_hora.substring(11, 16); 
      const inicioExistente = timeToMinutes(horaExistente);
      const duracionExistente = cita.duracion_aux || 60;
      const finExistente = inicioExistente + duracionExistente;

      if (inicioNueva < finExistente && finNueva > inicioExistente) {
        return {
          disponible: false,
          mensaje: `Ese espacio ya está reservado para una ${cita.servicio_aux}.`
        };
      }
    }

    return { disponible: true, mensaje: null };
  } catch (error) {
    console.error('Error disponibilidad:', error);
    return { disponible: false, mensaje: "Tuve un pequeño problema al ver la agenda. ¿Me das un segundo?" };
  }
}

/**
 * RESOLUTOR DE IDs
 */
async function obtenerIdsRelacionales(servicioNombre, especialistaNombre) {
  try {
    let servicioId = null, especialistaId = null, duracion = 60, precio = 0;

    if (servicioNombre && servicioNombre !== '...') {
      const { data: serv } = await supabase.from('servicios').select('id, duracion, precio').ilike('nombre', `%${servicioNombre}%`).maybeSingle();
      if (serv) { servicioId = serv.id; duracion = serv.duracion || 60; precio = serv.precio || 0; }
    }

    if (especialistaNombre && especialistaNombre !== '...' && especialistaNombre !== 'Asignar') {
      const { data: esp } = await supabase.from('especialistas').select('id').ilike('nombre', `%${especialistaNombre}%`).maybeSingle();
      if (esp) especialistaId = esp.id;
    }

    return { servicioId, especialistaId, duracion, precio };
  } catch (error) {
    return { servicioId: null, especialistaId: null, duracion: 60, precio: 0 };
  }
}

/**
 * BUSCA LA PRÓXIMA CITA DEL CLIENTE
 */
async function buscarCitaProxima(clienteId) {
  try {
    const { data, error } = await supabase
      .from('citas')
      .select('*')
      .eq('cliente_id', clienteId)
      .gte('fecha_hora', new Date().toISOString())
      .in('estado', ['Confirmada', 'En proceso'])
      .order('fecha_hora', { ascending: true })
      .limit(1)
      .maybeSingle();
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error buscando cita:', error);
    return null;
  }
}

/**
 * ACTUALIZA UNA CITA EXISTENTE
 */
async function actualizarCita(citaId, nuevosDatos) {
  try {
    const fechaHora = `${nuevosDatos.fecha}T${nuevosDatos.hora}:00`;
    
    // 1. Actualizar en Supabase
    const { data, error: sError } = await supabase
      .from('citas')
      .update({
        servicio_id: nuevosDatos.servicioId,
        especialista_id: nuevosDatos.especialistaId,
        fecha_hora: fechaHora,
        servicio_aux: nuevosDatos.servicio,
        duracion_aux: nuevosDatos.duracion
      })
      .eq('id', citaId)
      .select()
      .single();

    if (sError) throw sError;

    // 2. Actualizar en Airtable
    const baseId = CONFIG.AIRTABLE_BASE_ID;
    const tableName = encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME);
    const formula = encodeURIComponent(`AND({Teléfono} = '${nuevosDatos.telefono}', {Estado} = 'Confirmada')`);
    const searchUrl = `https://api.airtable.com/v0/${baseId}/${tableName}?filterByFormula=${formula}&sort%5B0%5D%5Bfield%5D=Fecha&sort%5B0%5D%5Bdirection%5D=asc`;
    
    const searchRes = await axios.get(searchUrl, {
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const records = searchRes.data.records || [];
    if (records.length > 0) {
      const airtableRecordId = records[0].id;
      const updateUrl = `https://api.airtable.com/v0/${baseId}/${tableName}/${airtableRecordId}`;
      
      await axios.patch(updateUrl, {
        fields: {
          "Servicio": nuevosDatos.servicio,
          "Fecha": fechaHora, // Enviamos el timestamp completo (Fecha + Hora)
          "Hora": nuevosDatos.hora,
          "Especialista": nuevosDatos.especialista,
          "Importe estimado": nuevosDatos.precio,
          "Duración estimada (minutos)": nuevosDatos.duracion
        }
      }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    }

    return { success: true };
  } catch (error) {
    console.error('Error actualizando cita:', error);
    return { success: false, error: error.message };
  }
}

/**
 * CANCELA UNA CITA
 */
async function cancelarCita(citaId, telefono) {
  try {
    // 1. Cancelar en Supabase
    const { error: sError } = await supabase
      .from('citas')
      .update({ estado: 'Cancelada' })
      .eq('id', citaId);

    if (sError) throw sError;

    // 2. Cancelar en Airtable
    const baseId = CONFIG.AIRTABLE_BASE_ID;
    const tableName = encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME);
    const formula = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const searchUrl = `https://api.airtable.com/v0/${baseId}/${tableName}?filterByFormula=${formula}`;
    
    const searchRes = await axios.get(searchUrl, {
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const records = searchRes.data.records || [];
    if (records.length > 0) {
      const airtableRecordId = records[0].id;
      const updateUrl = `https://api.airtable.com/v0/${baseId}/${tableName}/${airtableRecordId}`;
      
      await axios.patch(updateUrl, {
        fields: { "Estado": "Cancelada" }
      }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    }

    return { success: true };
  } catch (error) {
    console.error('Error cancelando cita:', error);
    return { success: false, error: error.message };
  }
}

/**
 * REGISTRO DE CITA
 */
async function registrarCita(datos) {
  try {
    const fechaHora = `${datos.fecha}T${datos.hora}:00`;

    const { data, error: sError } = await supabase.from('citas').insert({
      cliente_id: datos.clienteId,
      servicio_id: datos.servicioId,
      especialista_id: datos.especialistaId,
      fecha_hora: fechaHora,
      estado: 'Confirmada',
      nombre_cliente_aux: `${datos.nombre} ${datos.apellido}`.trim(),
      servicio_aux: datos.servicio,
      duracion_aux: datos.duracion
    }).select().single();

    if (sError) throw sError;

    // 2. Guardar en Airtable (Espejo para el dueño)
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    await axios.post(url, {
      records: [{
        fields: {
          "ID_Supabase": data.id,
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": fechaHora, // Enviamos el timestamp completo (Fecha + Hora)
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion
        }
      }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });

    return { success: true, id: data.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============ WEBHOOK PRINCIPAL (WhatsApp Sandbox) ============

// Health Check para verificar que Aura está viva
app.get('/webhook', (req, res) => res.status(200).send('AuraSync Webhook is Active! 🚀'));
app.get('/', (req, res) => res.status(200).send('AuraSync Server is Running! 🚀'));

// AURA RESPONDE A TODO: Si Twilio manda a / o a /webhook, Aura responde igual.
app.post('*', async (req, res) => {
  console.log('📩 ¡LLEGÓ UN MENSAJE! Procesando...');
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : '';
  
  if (!userPhone) return res.status(200).send('<Response></Response>');

  try {
    // 1. PROCESAR ENTRADA (Texto o Audio)
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) {
        console.error('Deepgram Error:', error.message);
      }
    }

    // 2. IDENTIFICAR CLIENTE
    let { data: cliente } = await supabase.from('clientes').select('id, nombre, apellido, fecha_nacimiento').eq('telefono', userPhone).maybeSingle();
    const esNuevo = !cliente;
    const perfilIncompleto = cliente && (!cliente.nombre || !cliente.apellido || !cliente.fecha_nacimiento);

    // 3. RECUPERAR HISTORIAL
    const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(10);
    const historial = mensajes ? mensajes.reverse() : [];

    // 4. DATOS DE NEGOCIO
    const { data: especialistas } = await supabase.from('especialistas').select('nombre, rol, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    const especialistasList = especialistas?.map(e => `- ${e.nombre} (${e.rol}): ${e.expertise}`).join('\n') || "";
    const serviciosList = servicios?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion} min)`).join(', ') || "";

    // 5. PERSONALIDAD DE AURA (System Prompt)
    const hoy = new Intl.DateTimeFormat('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil' }).format(new Date());

    let systemPrompt = `Eres Aura, la Coordinadora Ejecutiva de AuraSync. Eres la mano derecha de nuestros especialistas y la guía de confianza de nuestros clientes. 

[TU PERSONALIDAD]
- **Humana y Sofisticada**: Hablas con seguridad y calidez. Eres extremadamente eficiente.
- **Persuasiva**: "Vendes" la experiencia. Destaca el expertise de los especialistas.
- **Proactiva**: Si un horario está ocupado, ofrece inmediatamente la mejor alternativa.
- **Gestión de Citas**: Puedes agendar, reagendar (cambiar fecha/hora) o cancelar citas.
- **Lenguaje**: Usa "nosotros", "nuestro equipo", "te he reservado".

[REGLAS DE ORO]
1. **Registro Primero**: Si el cliente es nuevo o le faltan datos (Nombre, Apellido, Fecha de Nacimiento), tu prioridad es obtenerlos con elegancia antes de agendar.
2. **Venta de Expertise**: Usa la lista de especialistas para persuadir.
3. **Agenda Perfecta**: Intenta agrupar las citas para optimizar el tiempo.
4. **Reagendamiento/Cancelación**: Si el cliente pide cambiar o cancelar, identifica la intención y usa la acción correspondiente en el JSON.

[DATOS]
Especialistas: ${especialistasList}
Servicios: ${serviciosList}
Hoy es ${hoy}. Horario: 9:00 a 18:00.`;

    if (esNuevo || perfilIncompleto) {
      systemPrompt += `\n[ESTADO: REGISTRO PENDIENTE] Pide Nombre, Apellido y Fecha de Nacimiento (YYYY-MM-DD).`;
    }

    systemPrompt += `\n[SALIDA JSON] Agrega siempre al final: DATA_JSON:{"accion":"agendar|reagendar|cancelar","nombre":"...","apellido":"...","fecha_nacimiento":"...","cita_fecha":"...","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

    // 6. EJECUCIÓN IA (GPT-4o)
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, ...historial.map((m) => ({ role: m.rol, content: m.contenido })), { role: "user", content: textoUsuario }],
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let finalMessage = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        const datos = JSON.parse(jsonMatch[1].trim());
        
        // Registro/Actualización de Cliente
        if (datos.nombre !== "..." && datos.apellido !== "..." && datos.fecha_nacimiento.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const { data: upserted } = await supabase.from('clientes').upsert({
            telefono: userPhone, nombre: datos.nombre, apellido: datos.apellido, fecha_nacimiento: datos.fecha_nacimiento
          }, { onConflict: 'telefono' }).select().single();
          if (upserted) {
            cliente = upserted;
            if (esNuevo) finalMessage += "\n\n✅ ¡Bienvenido a AuraSync! Ya te he registrado en nuestro sistema VIP.";
          }
        }

        // B. Gestión de Citas (Agendar, Reagendar, Cancelar)
        if (cliente && !perfilIncompleto && datos.accion) {
          const citaExistente = await buscarCitaProxima(cliente.id);

          if (datos.accion === 'cancelar') {
            if (citaExistente) {
              const res = await cancelarCita(citaExistente.id, userPhone);
              if (res.success) finalMessage += `\n\n✅ Entendido. He cancelado tu cita con éxito. Espero verte pronto en otra ocasión.`;
            } else {
              finalMessage += `\n\nNo encontré ninguna cita próxima para cancelar. ¿Deseas agendar una nueva?`;
            }
          } 
          else if (datos.accion === 'reagendar' || datos.accion === 'agendar') {
            if (datos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/) && datos.cita_hora.match(/^\d{2}:\d{2}$/)) {
              const ids = await obtenerIdsRelacionales(datos.cita_servicio, datos.cita_especialista);
              const disp = await verificarDisponibilidad(datos.cita_fecha, datos.cita_hora, ids.especialistaId, ids.duracion);

              if (!disp.disponible) {
                finalMessage += `\n\n${disp.mensaje} ¿Te gustaría que busquemos otro horario?`;
              } else {
                if (datos.accion === 'reagendar' && citaExistente) {
                  const res = await actualizarCita(citaExistente.id, {
                    clienteId: cliente.id, telefono: userPhone,
                    fecha: datos.cita_fecha, hora: datos.cita_hora, servicio: datos.cita_servicio || citaExistente.servicio_aux, especialista: datos.cita_especialista,
                    servicioId: ids.servicioId || citaExistente.servicio_id, especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio
                  });
                  if (res.success) finalMessage += `\n\n✅ ¡Listo! He movido tu cita con éxito. Nos vemos el ${datos.cita_fecha} a las ${datos.cita_hora}.`;
                } else {
                  const resCita = await registrarCita({
                    clienteId: cliente.id, telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido,
                    fecha: datos.cita_fecha, hora: datos.cita_hora, servicio: datos.cita_servicio, especialista: datos.cita_especialista,
                    servicioId: ids.servicioId, especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio
                  });
                  if (resCita.success) finalMessage += `\n\n✅ ¡Listo! Tu cita ha quedado confirmada. Te esperamos.`;
                }
              }
            }
          }
        }
      } catch (e) { console.error('JSON Error'); }
    }

    // 7. MEMORIA Y RESPUESTA (TwiML)
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: finalMessage }]);

    const twiml = new MessagingResponse();
    twiml.message(finalMessage);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());

  } catch (err) {
    console.error('Global Error:', err.message);
    const twiml = new MessagingResponse();
    twiml.message('Lo siento, tuve un problema técnico. ¿Podrías repetirme eso?');
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AuraSync Online en puerto ${PORT}`);
  console.log(`🔗 Webhook listo en: /webhook`);
});

export default app;
