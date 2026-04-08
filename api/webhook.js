import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import twilio from 'twilio';
import syncAirtable from './sync-airtable.js';
import dailyReport from './daily-report.js';
import reminders from './reminders.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const { MessagingResponse } = twilio.twiml;

// ============ WEBHOOK PRINCIPAL ============

app.get(['/', '/webhook', '/api/webhook'], (req, res) => {
  res.status(200).send('🚀 AuraSync Online');
});

app.post(['/', '/webhook', '/api/webhook'], async (req, res) => {
  const { Body, From, MediaUrl0 } = req.body;
  
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`📥 [${new Date().toISOString()}] NUEVA SOLICITUD`);
  console.log(`📱 De: ${From || 'Desconocido'}`);
  console.log(`💬 Body: ${Body || '(vacío)'}`);
  console.log(`🎙️ Media: ${MediaUrl0 ? 'SÍ' : 'NO'}`);
  console.log(`═══════════════════════════════════════════════════\n`);
  
  const userPhone = From ? From.replace('whatsapp:', '').replace('+', '').trim() : '';
  
  if (!userPhone) {
    console.log('❌ CRÍTICO: No se detectó número de teléfono');
    return res.status(200).send('<Response></Response>');
  }

  let respuestaParaUsuario = "";
  let textoUsuario = Body || "";
  let accionData = null;

  try {
    // ========== PROCESAMIENTO DE AUDIO ==========
    if (MediaUrl0 && !respuestaParaUsuario) {
      console.log('🎙️ Procesando nota de voz...');
      try {
        const dr = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true", 
          { url: MediaUrl0 }, 
          { 
            headers: { 
              'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 
              'Content-Type': 'application/json' 
            },
            timeout: 10000
          }
        );
        textoUsuario = dr.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log(`✅ Transcripción: "${textoUsuario}"`);
      } catch (audioError) {
        console.error('❌ Error Deepgram:', audioError.message);
        respuestaParaUsuario = "Disculpa, no pude escuchar tu nota de voz claramente. ¿Podrías escribirme? 🎙️";
      }
    }

    // ========== OBTENER CONTEXTO ==========
    console.log('🔍 Obteniendo contexto...');
    
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .select('*')
      .or(`telefono.eq.${userPhone},telefono.eq.+${userPhone}`)
      .maybeSingle();
    
    if (clienteError) console.error('⚠️ Error consultando cliente:', clienteError.message);
    console.log(cliente ? `👤 Cliente: ${cliente.nombre}` : '👤 Cliente NUEVO');

    const { data: esp, error: espError } = await supabase.from('especialistas').select('id, nombre, rol, expertise');
    if (espError) console.error('⚠️ Error especialistas:', espError.message);
    
    const { data: serv, error: servError } = await supabase.from('servicios').select('id, nombre, precio, duracion');
    if (servError) console.error('⚠️ Error servicios:', servError.message);

    const hoy = new Date().toLocaleDateString('es-EC', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
      timeZone: 'America/Guayaquil' 
    });

    const { data: mensajes } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(6);
    const historial = mensajes ? mensajes.reverse() : [];

    // ========== SYSTEM PROMPT ==========
    const systemPrompt = `Eres Aura, Coordinadora Ejecutiva de AuraSync. Profesional, cálida, humana. NUNCA digas que eres IA.

[REGLAS DE ORO]
1. Cliente REGISTRADO (ya tienes sus datos): NO pidas nombre, ciudad, fecha nacimiento. Solo confirma la cita.
2. Cliente NUEVO: pide nombre, ciudad, fecha nacimiento (YYYY-MM-DD) ANTES de agendar.
3. Si propones horario alternativo (ej: "17:15 en lugar de 17:00") y usuario acepta: CONFIRMA la cita inmediatamente.
4. Si usuario dice "sí", "ok", "dale", "perfecto": está aceptando tu última propuesta. Confirma la cita.

[CONTEXTO]
- Especialistas: ${esp?.map(e => `${e.nombre} (${e.rol})`).join(', ') || 'Consultar'}
- Servicios: ${serv?.map(s => `${s.nombre} $${s.precio}, ${s.duracion}min`).join(', ') || 'Consultar'}
- Horario: 9:00 a 18:00 (Ecuador)
- Hoy: ${hoy}
- Cliente actual: ${cliente ? `${cliente.nombre} (REGISTRADO)` : 'NUEVO - requiere registro'}

[FORMATO OBLIGATORIO AL FINAL]
DATA_JSON:{"accion":"none"|"agendar"|"reagendar"|"cancelar","nombre":"${cliente?.nombre || '...'}","apellido":"${cliente?.apellido || '...'}","ciudad":"${cliente?.ciudad || '...'}","fecha_nacimiento":"${cliente?.fecha_nacimiento || '...'}","cita_fecha":"YYYY-MM-DD","cita_hora":"HH:MM","cita_servicio":"...","cita_especialista":"..."}`;

    // ========== LLAMADA A OPENAI ==========
    if (!respuestaParaUsuario) {
      console.log('🤖 Consultando OpenAI...');
      
      try {
        const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: "gpt-4o", 
          messages: [
            { role: "system", content: systemPrompt }, 
            ...historial.map(m => ({ role: m.rol, content: m.contenido })), 
            { role: "user", content: textoUsuario }
          ], 
          temperature: 0.2,
          max_tokens: 400
        }, { 
          headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` },
          timeout: 12000
        });
        
        const fullReply = aiRes.data.choices[0].message.content;
        console.log('📝 RESPUESTA:', fullReply.substring(0, 200) + '...');
        
        const { mensajeLimpio, datosAccion } = extraerJSON(fullReply);
        respuestaParaUsuario = mensajeLimpio;
        accionData = datosAccion;
        
      } catch (aiError) {
        console.error('❌ Error OpenAI:', aiError.message);
        respuestaParaUsuario = cliente 
          ? `Disculpa ${cliente.nombre}, ¿me repetirías qué servicio necesitas? 💫`
          : `Hola, bienvenido a AuraSync. ¿Me regalas tu nombre completo, ciudad y fecha de nacimiento? ✨`;
      }
    }

    // ========== DETECTAR CONFIRMACIÓN SIMPLE ==========
    if ((!accionData || accionData.accion === 'none') && cliente && !respuestaParaUsuario) {
      const textoLower = textoUsuario.toLowerCase().trim();
      const confirmaciones = ['sí', 'si', 'ok', 'vale', 'perfecto', 'dale', 'bueno', 'sí por favor', 'sí gracias', 'sí, gracias', 'sí dale', 'ok dale', 'sí, dale', 'perfecto, dale'];
      
      const esConfirmacion = confirmaciones.some(c => textoLower === c || textoLower.startsWith(c));
      
      if (esConfirmacion) {
        // Buscar última propuesta de Aura
        const ultimaRespuestaAura = historial
          .filter(m => m.rol === 'assistant')
          .pop()?.contenido || '';
        
        console.log('🔍 Última propuesta de Aura:', ultimaRespuestaAura.substring(0, 100));
        
        // Extraer hora propuesta (formato HH:MM)
        const horaMatch = ultimaRespuestaAura.match(/(\d{1,2}):(\d{2})/);
        const horaPropuesta = horaMatch ? `${horaMatch[1].padStart(2,'0')}:${horaMatch[2]}` : null;
        
        // Extraer fecha mencionada (hoy, mañana, o fecha específica)
        let fechaPropuesta = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
        if (ultimaRespuestaAura.toLowerCase().includes('mañana')) {
          const manana = new Date();
          manana.setDate(manana.getDate() + 1);
          fechaPropuesta = manana.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
        }
        
        // Detectar servicio del contexto
        let servicioDetectado = null;
        for (const s of serv || []) {
          if (ultimaRespuestaAura.toLowerCase().includes(s.nombre.toLowerCase())) {
            servicioDetectado = s;
            break;
          }
        }
        // Fallback: si menciona "corte" o "cabello"
        if (!servicioDetectado && (ultimaRespuestaAura.toLowerCase().includes('corte') || ultimaRespuestaAura.toLowerCase().includes('cabello'))) {
          servicioDetectado = serv?.find(s => s.nombre.toLowerCase().includes('corte'));
        }
        
        // Detectar especialista del contexto
        let especialistaDetectado = null;
        for (const e of esp || []) {
          if (ultimaRespuestaAura.toLowerCase().includes(e.nombre.toLowerCase())) {
            especialistaDetectado = e;
            break;
          }
        }
        
        if (horaPropuesta && servicioDetectado) {
          console.log('✅ CONFIRMACIÓN DETECTADA:', {
            fecha: fechaPropuesta,
            hora: horaPropuesta,
            servicio: servicioDetectado.nombre,
            especialista: especialistaDetectado?.nombre || 'No especificado'
          });
          
          accionData = {
            accion: "agendar",
            nombre: cliente.nombre,
            apellido: cliente.apellido || '',
            ciudad: cliente.ciudad || '',
            fecha_nacimiento: cliente.fecha_nacimiento || '',
            cita_fecha: fechaPropuesta,
            cita_hora: horaPropuesta,
            cita_servicio: servicioDetectado.nombre,
            cita_especialista: especialistaDetectado?.nombre || "..."
          };
          
          respuestaParaUsuario = ""; // Se sobreescribirá con confirmación real
        }
      }
    }

    // ========== PROCESAR ACCIONES ==========
    if (accionData && accionData.accion && accionData.accion !== 'none' && !respuestaParaUsuario) {
      console.log(`🎯 Acción: ${accionData.accion}`);
      
      let clienteActivo = cliente;

      // ----- REGISTRO NUEVO CLIENTE -----
      if (!cliente && esRegistroCompleto(accionData)) {
        console.log('📝 Registrando cliente...');
        
        const { data: nuevoCliente, error: registroError } = await supabase
          .from('clientes')
          .insert({
            telefono: userPhone,
            nombre: accionData.nombre,
            apellido: accionData.apellido,
            ciudad: accionData.ciudad,
            fecha_nacimiento: accionData.fecha_nacimiento,
            created_at: new Date().toISOString()
          })
          .select()
          .single();
        
        if (registroError) {
          console.error('❌ Error registro:', registroError);
          respuestaParaUsuario = `Tuve un inconveniente registrando tus datos. ¿Lo intentamos de nuevo? 🙏`;
          accionData = null;
        } else {
          console.log('✅ Cliente registrado:', nuevoCliente.id);
          clienteActivo = nuevoCliente;
          
          if (accionData.accion === 'agendar') {
            const resultadoCita = await procesarAccionCita(accionData, nuevoCliente, userPhone, esp, serv);
            respuestaParaUsuario = resultadoCita.exito 
              ? `¡Perfecto ${nuevoCliente.nombre}! Ya estás registrado y tu cita confirmada. 🌟\n\n${resultadoCita.mensaje}`
              : `Bienvenido ${nuevoCliente.nombre}. ${resultadoCita.mensaje}`;
          } else {
            respuestaParaUsuario = `¡Bienvenido ${nuevoCliente.nombre}! Tu perfil VIP está activo. ¿En qué puedo ayudarte? ✨`;
          }
          accionData = null;
        }
      } else if (!cliente && accionData.accion === 'agendar') {
        respuestaParaUsuario = `Para darte nuestro servicio VIP, necesito tu nombre completo, ciudad y fecha de nacimiento. ¿Me los compartes? 💎`;
        accionData = null;
      }

      // ----- CITAS PARA CLIENTES REGISTRADOS -----
      if (clienteActivo && clienteActivo.id && accionData && accionData.accion !== 'none' && !respuestaParaUsuario) {
        if (!esp?.length || !serv?.length) {
          respuestaParaUsuario = "Dame un momento, estoy revisando la agenda... 🌸";
        } else {
          const resultado = await procesarAccionCita(accionData, clienteActivo, userPhone, esp, serv);
          respuestaParaUsuario = resultado.mensaje;
        }
      }
    }

    // ========== GUARDAR Y RESPONDER ==========
    console.log('💾 Guardando conversación...');
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: respuestaParaUsuario, created_at: new Date().toISOString() }
    ]);

    const twiml = new MessagingResponse();
    twiml.message(respuestaParaUsuario);
    res.setHeader('Content-Type', 'text/xml');
    
    console.log(`✅ Respuesta enviada`);
    console.log(`═══════════════════════════════════════════════════\n`);
    
    return res.status(200).send(twiml.toString());

  } catch (error) { 
    console.error('❌❌❌ ERROR CRÍTICO:', error);
    console.error('Stack:', error.stack);
    
    const twiml = new MessagingResponse();
    twiml.message("Disculpa, tuve un momento de distracción. ¿Me repites por favor? 🌸");
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  }
});

// ============ FUNCIONES AUXILIARES ============

function extraerJSON(fullReply) {
  const jsonMatch = fullReply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})\s*$/i);
  
  if (jsonMatch) {
    try {
      const datos = JSON.parse(jsonMatch[1]);
      const mensaje = fullReply.replace(/DATA_JSON[\s\S]*/i, '').trim();
      return { mensajeLimpio: mensaje, datosAccion: datos };
    } catch (e) {
      console.log('⚠️ JSON inválido:', e.message);
    }
  }
  
  return { mensajeLimpio: fullReply, datosAccion: null };
}

function esRegistroCompleto(accionData) {
  return accionData?.nombre && accionData.nombre !== "..." && 
         accionData?.apellido && accionData.apellido !== "..." &&
         accionData?.ciudad && accionData.ciudad !== "..." &&
         accionData?.fecha_nacimiento && /^\d{4}-\d{2}-\d{2}$/.test(accionData.fecha_nacimiento);
}

// ============ PROCESAR ACCIONES DE CITA ============

async function procesarAccionCita(datos, cliente, telefono, especialistasLista, serviciosLista) {
  console.log(`\n🎯 PROCESANDO: ${datos.accion?.toUpperCase()}`);
  
  const resultado = { exito: false, mensaje: '' };

  try {
    if (!datos?.accion) {
      return { ...resultado, mensaje: '¿Qué te gustaría hacer? Agendar, reprogramar o cancelar? 💫' };
    }

    if (!especialistasLista?.length || !serviciosLista?.length) {
      return { ...resultado, mensaje: 'Estoy revisando disponibilidad. Un momento... 🌸' };
    }

    // ----- AGENDAR -----
    if (datos.accion === 'agendar') {
      
      if (!datos.cita_fecha || datos.cita_fecha === "..." || !datos.cita_hora || datos.cita_hora === "...") {
        return { ...resultado, mensaje: '¿Para qué fecha y hora te gustaría tu cita? 📅' };
      }

      // Buscar servicio
      let servicio = null;
      if (datos.cita_servicio && datos.cita_servicio !== "...") {
        const busqueda = datos.cita_servicio.toLowerCase().trim();
        servicio = serviciosLista.find(s => 
          s.nombre.toLowerCase().includes(busqueda) || busqueda.includes(s.nombre.toLowerCase())
        );
      }

      // Fallback para "corte"
      if (!servicio && datos.cita_servicio?.toLowerCase().includes('corte')) {
        servicio = serviciosLista.find(s => s.nombre.toLowerCase().includes('corte'));
      }

      if (!servicio) {
        const lista = serviciosLista.map(s => s.nombre).join(', ');
        return { ...resultado, mensaje: `¿Qué servicio te gustaría? Tenemos: ${lista} 💫` };
      }

      // Buscar especialista
      let especialista = null;
      if (datos.cita_especialista && datos.cita_especialista !== "...") {
        const busqueda = datos.cita_especialista.toLowerCase().trim();
        especialista = especialistasLista.find(e => 
          e.nombre.toLowerCase().includes(busqueda) || busqueda.includes(e.nombre.toLowerCase())
        );
      }

      // Si no hay especialista, usar el primero disponible o pedir
      if (!especialista) {
        // Asignar el primer especialista como default (o pedir según tu preferencia)
        especialista = especialistasLista[0];
        console.log('⚠️ Especialista no especificado, usando default:', especialista.nombre);
      }

      // Verificar disponibilidad
      console.log('🔍 Verificando disponibilidad...');
      const disponible = await verificarDisponibilidad(
        datos.cita_fecha, datos.cita_hora, especialista.id, servicio.duracion
      );

      if (!disponible.ok) {
        return { ...resultado, mensaje: disponible.mensaje };
      }

      // ===== INSERT EN SUPABASE (COLUMNAS EXACTAS DE TU TABLA) =====
      console.log('💾 Creando cita...');
      
      const citaData = {
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        especialista_id: especialista.id,
        fecha_hora: `${datos.cita_fecha}T${datos.cita_hora}:00-05:00`,
        estado: 'Confirmada',
        nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
        servicio_aux: servicio.nombre,
        duracion_aux: servicio.duracion,
        created_at: new Date().toISOString()
        // NO incluir: precio (no existe), telefono_aux (no existe), motivo_cancelacion (null)
      };

      const { data: citaCreada, error: errorCita } = await supabase
        .from('citas')
        .insert(citaData)
        .select()
        .single();

      if (errorCita) {
        console.error('❌ ERROR SUPABASE:', errorCita);
        throw new Error(`Error al guardar cita: ${errorCita.message}`);
      }

      if (!citaCreada?.id) {
        throw new Error('Supabase no retornó ID de cita');
      }

      console.log('✅ Cita creada:', citaCreada.id);

      // Sincronizar con Airtable
      return await sincronizarAirtable(
        citaCreada, cliente, telefono, servicio, especialista, datos, resultado
      );
    }

    // ----- REAGENDAR -----
    else if (datos.accion === 'reagendar') {
      if (!datos.cita_fecha || !datos.cita_hora) {
        return { ...resultado, mensaje: '¿Para cuándo quieres reprogramar? 📅' };
      }

      const { data: citaActual } = await supabase
        .from('citas')
        .select('id, servicio_id, especialista_id, fecha_hora, servicio_aux, duracion_aux')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', new Date().toISOString())
        .order('fecha_hora', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!citaActual) {
        return { ...resultado, mensaje: 'No encontré citas próximas para reprogramar. 💫' };
      }

      const duracion = citaActual.duracion_aux || 60;
      const disponible = await verificarDisponibilidad(
        datos.cita_fecha, datos.cita_hora, citaActual.especialista_id, duracion
      );

      if (!disponible.ok) {
        return { ...resultado, mensaje: disponible.mensaje };
      }

      const nuevaFechaHora = `${datos.cita_fecha}T${datos.cita_hora}:00-05:00`;
      const { error: updateError } = await supabase
        .from('citas')
        .update({ 
          fecha_hora: nuevaFechaHora,
          updated_at: new Date().toISOString()
        })
        .eq('id', citaActual.id);

      if (updateError) throw new Error(`Error actualizando: ${updateError.message}`);

      // Actualizar Airtable
      try {
        const formula = encodeURIComponent(`{ID_Supabase} = '${citaActual.id}'`);
        const searchRes = await axios.get(
          `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`,
          { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } }
        );

        if (searchRes.data.records.length > 0) {
          await axios.patch(
            `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`,
            {
              records: [{
                id: searchRes.data.records[0].id,
                fields: { 
                  "Fecha": datos.cita_fecha, 
                  "Hora": datos.cita_hora,
                  "Estado": "Confirmada",
                  "Última actualización": new Date().toISOString()
                }
              }]
            },
            { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } }
          );
        }
      } catch (airtableError) {
        console.error('⚠️ Error actualizando Airtable:', airtableError.message);
      }

      return {
        exito: true,
        mensaje: `🔄 Cita reprogramada para el ${formatearFecha(datos.cita_fecha)} a las ${datos.cita_hora}. ¡Nos vemos! ✨`
      };
    }

    // ----- CANCELAR -----
    else if (datos.accion === 'cancelar') {
      const { data: citaActual } = await supabase
        .from('citas')
        .select('id, fecha_hora, servicio_aux')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', new Date().toISOString())
        .order('fecha_hora', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!citaActual) {
        return { ...resultado, mensaje: 'No encontré citas próximas para cancelar. 💫' };
      }

      const { error: cancelError } = await supabase
        .from('citas')
        .update({ 
          estado: 'Cancelada',
          motivo_cancelacion: 'Cancelada por cliente vía WhatsApp',
          updated_at: new Date().toISOString()
        })
        .eq('id', citaActual.id);

      if (cancelError) throw new Error(`Error cancelando: ${cancelError.message}`);

      // Cancelar en Airtable
      try {
        const formula = encodeURIComponent(`{ID_Supabase} = '${citaActual.id}'`);
        const searchRes = await axios.get(
          `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`,
          { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } }
        );

        if (searchRes.data.records.length > 0) {
          await axios.patch(
            `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`,
            {
              records: [{
                id: searchRes.data.records[0].id,
                fields: { 
                  "Estado": "Cancelada",
                  "Última actualización": new Date().toISOString()
                }
              }]
            },
            { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } }
          );
        }
      } catch (airtableError) {
        console.error('⚠️ Error cancelando en Airtable:', airtableError.message);
      }

      return {
        exito: true,
        mensaje: `🚫 Cita de "${citaActual.servicio_aux}" cancelada. ¿Agendamos otra? 💫`
      };
    }

    return { ...resultado, mensaje: '¿Cómo puedo ayudarte hoy? ✨' };

  } catch (error) {
    console.error('❌ ERROR procesarAccionCita:', error);
    return { exito: false, mensaje: 'Tuve un pequeño contratiempo. ¿Lo intentamos de nuevo? 🌸' };
  }
}

// ============ SINCRONIZAR AIRTABLE ============

async function sincronizarAirtable(citaCreada, cliente, telefono, servicio, especialista, datos, resultado) {
  console.log('☁️ Sincronizando Airtable...');
  
  try {
    await axios.post(
      `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`,
      {
        records: [{
          fields: {
            "ID_Supabase": citaCreada.id,
            "Cliente": `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
            "Servicio": servicio.nombre,
            "Fecha": datos.cita_fecha,
            "Hora": datos.cita_hora,
            "Especialista": especialista.nombre,
            "Teléfono": telefono,
            "Estado": "Confirmada",
            "Importe estimado": servicio.precio,
            "Duración estimada (minutos)": servicio.duracion,
            "Email de cliente": cliente.email || '',
            "Fecha creación": new Date().toISOString()
          }
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log('✅ Airtable sincronizado');
  } catch (airtableError) {
    console.error('⚠️ Error Airtable (no crítico):', airtableError.message);
  }

  return {
    exito: true,
    mensaje: `✅ *Cita Confirmada*\n\n📅 ${formatearFecha(datos.cita_fecha)} a las ${datos.cita_hora}\n💇‍♀️ ${servicio.nombre}\n👤 Con ${especialista.nombre}\n⏱️ ${servicio.duracion} min\n💰 $${servicio.precio}\n\nTe espero. ✨`
  };
}

// ============ UTILIDADES ============

function timeToMinutes(hora) {
  if (!hora || typeof hora !== 'string') return null;
  const [h, m] = hora.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  console.log(`   📅 ${fecha} ⏰ ${hora} 👤 ${especialistaId} ⏱️ ${duracionMinutos}`);
  
  if (!fecha || !hora || !especialistaId) {
    return { ok: false, mensaje: 'Necesito confirmar fecha, hora y especialista. 🌸' };
  }

  const inicioNueva = timeToMinutes(hora);
  if (inicioNueva === null) {
    return { ok: false, mensaje: 'Formato de hora incorrecto. ¿HH:MM? ⏰' };
  }
  
  const duracion = parseInt(duracionMinutos) || 60;
  const finNueva = inicioNueva + duracion;
  const horaMaximaInicio = 1080 - duracion; // 18:00 = 1080 min
  
  if (inicioNueva < 540) { // 9:00 = 540
    return { ok: false, mensaje: 'Horario desde las 9:00. ¿Te funciona? ☀️' };
  }
  
  if (inicioNueva > horaMaximaInicio) {
    const horaSugerida = Math.floor(horaMaximaInicio / 60);
    const minSugerida = horaMaximaInicio % 60;
    const horaStr = `${horaSugerida.toString().padStart(2,'0')}:${minSugerida.toString().padStart(2,'0')}`;
    return { ok: false, mensaje: `Para este servicio de ${duracion} minutos, el último horario es ${horaStr}. ¿Te funciona? ✨` };
  }

  // Verificar conflictos
  const { data: citasExistentes, error } = await supabase
    .from('citas')
    .select('fecha_hora, duracion_aux, servicio_aux')
    .eq('especialista_id', especialistaId)
    .gte('fecha_hora', `${fecha}T00:00:00`)
    .lte('fecha_hora', `${fecha}T23:59:59`)
    .in('estado', ['Confirmada', 'En proceso']);

  if (error) {
    console.error('❌ Error consultando citas:', error);
    return { ok: false, mensaje: 'Revisando agenda... Un momento. 🌸' };
  }

  for (const cita of citasExistentes || []) {
    const horaExistente = cita.fecha_hora.includes('T') 
      ? cita.fecha_hora.split('T')[1].substring(0, 5) 
      : cita.fecha_hora.substring(11, 16);
    
    const inicioExistente = timeToMinutes(horaExistente);
    const duracionExistente = cita.duracion_aux || 60;
    const finExistente = inicioExistente + duracionExistente;
    
    if (inicioNueva < finExistente && finNueva > inicioExistente) {
      return { 
        ok: false, 
        mensaje: `Ese horario se cruza con "${cita.servicio_aux}" a las ${horaExistente}. ¿Otra hora u otro especialista? 💫` 
      };
    }
  }

  console.log('   ✅ Disponibilidad confirmada');
  return { ok: true };
}

function formatearFecha(fechaISO) {
  if (!fechaISO) return '';
  const [anio, mes, dia] = fechaISO.split('-');
  const fecha = new Date(anio, mes - 1, dia);
  return fecha.toLocaleDateString('es-EC', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Guayaquil'
  });
}

// ============ OTRAS RUTAS ============

app.post('/api/sync-airtable', syncAirtable);
app.get('/api/daily-report', dailyReport);
app.get('/api/reminders', reminders);

export default async function handler(req, res) {
  return app(req, res);
}
