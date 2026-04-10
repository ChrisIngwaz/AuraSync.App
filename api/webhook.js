import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

const TIMEZONE = 'America/Guayaquil';

// CORREGIDO: getFechaEcuador para evitar desfases de zona horaria del servidor
function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  
  const fecha = new Date(Date.UTC(year, month - 1, day));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  
  return fecha.toISOString().split('T')[0];
}

// CORREGIDO: formatearFecha para que no reste un día al mostrar el mensaje
function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) {
    console.error('Fecha inválida:', fechaISO);
    return fechaISO || 'fecha por confirmar';
  }
  
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  // Forzamos a UTC al mediodía para evitar que toLocaleDateString cambie el día por desfase de zona horaria
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  
  return fecha.toLocaleDateString('es-EC', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    timeZone: 'UTC'
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  // ============ DEBUG TEMPORAL ============
  const debugFechas = {
    serverNow: new Date().toISOString(),
    serverDate: new Date().toDateString(),
    ecuadorDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }),
    ecuadorString: new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })
  };
  console.log('🔍 DEBUG FECHAS SERVIDOR:', JSON.stringify(debugFechas));
  // ============ FIN DEBUG ============

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log(`\n📱 ${userPhone}`);

  try {
    let textoUsuario = Body || "";
    
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { 
            headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('🎤:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Error con audio. Escribime por favor.</Message></Response>');
      }
    }

    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const esNuevo = !cliente?.nombre;

    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(6);
      
      if (mensajes) {
        historialFiltrado = mensajes.reverse();
      }
    } else {
      console.log('⚡ Cliente nuevo detectado.');
    }

    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
        const listaEsp = especialistas?.map(e => `${e.nombre} (Experto en: ${e.expertise})`).join(', ') || "nuestro equipo";
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";

    const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Tu comunicación debe ser indistinguible de la de un humano: cálida, elegante, natural y persuasiva.

[IDENTIDAD]
- Tono: Profesional pero cercano, sofisticado y conversacional.
- Personalidad: Eres una concierge de lujo muy humana.

[FLUJO DE CONVERSACIÓN - REGLA OBLIGATORIA Y ESTRICTA]
Sigue este orden exacto, sin saltarte ningún paso:

1. Cliente pide cita → Sugiere **al menos dos especialistas** con su expertise. Pregunta cuál prefiere. (Todo en un mensaje)

2. Cliente elige un especialista → Propón un horario concreto y di algo como: 
   "Perfecto, te propongo agendar con [Nombre] el [día] a las [hora]. ¿Te parece bien este horario?"
   → Pregunta claramente si confirma el horario.

3. Cliente confirma el horario y especialista → Recién entonces envía el mensaje de confirmación final con el texto:
   "✅ Cita confirmada: [fecha] a las [hora] con [especialista]."

- **Nunca** confirmes la cita antes de que el cliente explícitamente acepte el horario y especialista.
- Nunca pongas la confirmación con el check verde en el mismo mensaje donde propones el horario.
- Mantén mensajes cortos y naturales.

[RECOMENDACIONES Y PERSUASIÓN]
- Especialistas: ${listaEsp}
- Servicios: ${catalogo}
- Siempre recomienda mínimo dos especialistas cuando sea posible.

Ejemplo correcto de flujo:
- Usuario: Quiero un corte de pelo
- Aura: "Para corte de pelo te recomiendo a Carlos, experto en cortes modernos y masculinos, o a Sofia que es genial con cortes femeninos y texturas suaves. ¿Con quién te gustaría agendar?"
- Usuario: Con Carlos
- Aura: "Perfecto, Chris. Te propongo agendar con Carlos hoy a las 15:00. ¿Te parece bien este horario?"
- Usuario: Sí, está bien
- Aura: "✅ Cita confirmada: viernes, 10 de abril de 2026 a las 15:00 con Carlos."

[REGLAS DE ORO]
- Habla como una mujer profesional y amable.
- Sé cálida y conversacional.
- Nunca combines propuesta de horario + confirmación final en el mismo mensaje.
- Espera siempre la confirmación explícita del cliente antes de registrar la cita.

[FECHAS IMPORTANTE]
- Hoy es: ${formatearFecha(getFechaEcuador())}
- Mañana es: ${formatearFecha(getFechaEcuador(1))}

[DATA_JSON ESTRUCTURA]
Al final de cada respuesta, incluye estrictamente:
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "...",
  "cita_id": "..."
}`;

    const messages = [{ role: "system", content: systemPrompt }];
    historialFiltrado.forEach(msg => {
      messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido });
    });
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // ============ CORRECCIÓN FECHA v6 - Matemática pura ============
        const textoLower = (textoUsuario || '').toLowerCase();
        
        const ahoraUTC = new Date();
        const minutosDesdeMedianocheUTC = (ahoraUTC.getUTCHours() * 60) + ahoraUTC.getUTCMinutes();
        const minutosEcuador = minutosDesdeMedianocheUTC - (5 * 60); 
        
        const esAyerEnEcuador = minutosEcuador < 0;
        
        const diaHoyUTC = ahoraUTC.getUTCDate();
        const mesHoyUTC = ahoraUTC.getUTCMonth(); 
        const añoHoyUTC = ahoraUTC.getUTCFullYear();
        
        const fechaBase = new Date(Date.UTC(añoHoyUTC, mesHoyUTC, diaHoyUTC));
        if (esAyerEnEcuador) {
          fechaBase.setUTCDate(fechaBase.getUTCDate() - 1);
        }
        
        const fechaMañana = new Date(fechaBase);
        fechaMañana.setUTCDate(fechaBase.getUTCDate() + 1);
        
        const formatear = (fecha) => {
          return `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}-${String(fecha.getUTCDate()).padStart(2, '0')}`;
        };
        
        const fechaHoyStr = formatear(fechaBase);
        const fechaMañanaStr = formatear(fechaMañana);
        
        let fechaFinal = fechaMañanaStr; 
        
        if (textoLower.includes('mañana') || textoLower.includes('manana')) {
          fechaFinal = fechaMañanaStr;
          console.log('✅ Detectado: MAÑANA');
        } else if (textoLower.includes('hoy')) {
          fechaFinal = fechaHoyStr;
          console.log('✅ Detectado: HOY');
        } else if (datosExtraidos.cita_fecha && datosExtraidos.cita_fecha >= fechaHoyStr) {
          fechaFinal = datosExtraidos.cita_fecha;
          console.log('✅ Usando fecha OpenAI:', fechaFinal);
        }
        
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && esNuevo) {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido || "",
            fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          cliente = { nombre: datosExtraidos.nombre, apellido: datosExtraidos.apellido || "" };
        }

        const accion = datosExtraidos.accion || 'none';
        
        if (accion === 'cancelar') {
          const resultado = await cancelarCitaAirtable(userPhone, datosExtraidos.cita_id);
          mensajeAccion = resultado 
            ? "✅ Cita cancelada exitosamente." 
            : "No encontré citas activas para cancelar.";
          accionEjecutada = true;
        }
        
        else if (accion === 'reagendar') {
          if (fechaFinal && datosExtraidos.cita_hora) {
            const resultado = await reagendarCitaAirtable(userPhone, { ...datosExtraidos, cita_fecha: fechaFinal });
            mensajeAccion = resultado 
              ? `✅ Cita reprogramada para ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora}.`
              : "No pude reprogramar. ¿Tienes una cita activa?";
            accionEjecutada = true;
          }
        }
        
        else if (accion === 'agendar' || (fechaFinal && datosExtraidos.cita_hora)) {
          const tieneFecha = fechaFinal.match(/^\d{4}-\d{2}-\d{2}$/);
          const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
          
          if (tieneFecha && tieneHora && (cliente?.nombre || datosExtraidos.nombre)) {
            
            let servicioData = servicios?.find(s => 
              s.nombre.toLowerCase() === (datosExtraidos.cita_servicio || '').toLowerCase()
            ) || servicios?.find(s => 
              (datosExtraidos.cita_servicio || '').toLowerCase().includes(s.nombre.toLowerCase())
            ) || { nombre: datosExtraidos.cita_servicio || "Servicio", precio: 0, duracion: 60 };

            const disponible = await verificarDisponibilidadAirtable(
              fechaFinal,
              datosExtraidos.cita_hora,
              datosExtraidos.cita_especialista,
              servicioData.duracion
            );

            if (!disponible.ok) {
              const alternativa = await buscarAlternativaAirtable(
                fechaFinal,
                datosExtraidos.cita_hora,
                datosExtraidos.cita_especialista,
                servicioData.duracion,
                especialistas?.map(e => e.nombre)
              );
              
              mensajeAccion = `Ese horario no está disponible. ${alternativa.mensaje}`;
              accionEjecutada = true;
            } else {
              
              const nombreCliente = cliente?.nombre || datosExtraidos.nombre;
              const apellidoCliente = cliente?.apellido || datosExtraidos.apellido || "";
              const especialistaFinal = disponible.especialista || datosExtraidos.cita_especialista || "Asignar";
              
              const { data: citaSupabase } = await supabase
                .from('citas')
                .insert({
                  cliente_id: cliente?.id || null,
                  servicio_id: servicioData.id || null,
                  fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                  estado: 'Confirmada',
                  nombre_cliente_aux: `${nombreCliente} ${apellidoCliente}`.trim(),
                  servicio_aux: servicioData.nombre,
                  duracion_aux: servicioData.duracion,
                  created_at: new Date().toISOString()
                })
                .select()
                .single();

              const citaAirtable = await crearCitaAirtable({
                telefono: userPhone,
                nombre: nombreCliente,
                apellido: apellidoCliente,
                fecha: fechaFinal,
                hora: datosExtraidos.cita_hora,
                servicio: servicioData.nombre,
                especialista: especialistaFinal,
                precio: servicioData.precio,
                duracion: servicioData.duracion,
                supabase_id: citaSupabase?.id || null
              });

              if (citaAirtable) {
                mensajeAccion = `✅ Cita confirmada: ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora} con ${especialistaFinal}.`;
              } else {
                mensajeAccion = "Tuve un problema registrando la cita. ¿Lo intentamos de nuevo?";
              }
              accionEjecutada = true;
            }
          }
        }

      } catch (e) { 
        console.error('Error procesando JSON:', e.message); 
      }
    }

    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    
    if (accionEjecutada && mensajeAccion) {
      // Unimos la respuesta humana de Aura con la confirmación técnica
      cleanReply = `${cleanReply}\n\n${mensajeAccion}`;
    }

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento de distracción. ¿Me repites por favor? 🌸</Message></Response>');
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();

    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": fechaUTC,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion,
          "ID_Supabase": datos.supabase_id || null
        }
      }]
    };
    await axios.post(url, payload, { 
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) { 
    return false; 
  }
}

async function cancelarCitaAirtable(telefono, citaId) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    if (busqueda.data.records.length === 0) return false;
    const recordId = citaId || busqueda.data.records[0].id;
    await axios.patch(`${url}`, {
      records: [{ id: recordId, fields: { "Estado": "Cancelada" } }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    if (busqueda.data.records.length === 0) return false;
    const recordId = datos.cita_id || busqueda.data.records[0].id;
    const [h, min] = datos.cita_hora.split(':').map(Number);
    const [anio, mes, dia] = datos.cita_fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    await axios.patch(`${url}`, {
      records: [{ id: recordId, fields: { "Fecha": fechaUTC, "Hora": datos.cita_hora, "Estado": "Confirmada" } }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialistaSolicitado, duracionMinutos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    const citas = response.data.records;
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracionMinutos || 60);
    if (inicioNuevo < 540) return { ok: false, mensaje: "Nuestro horario comienza a las 9:00." };
    if (finNuevo > 1080) return { ok: false, mensaje: "Ese horario excede nuestra jornada." };
    for (const cita of citas) {
      const [he, me] = cita.fields.Hora.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + (cita.fields['Duración estimada (minutos)'] || 60);
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialistaSolicitado || cita.fields.Especialista === especialistaSolicitado) {
          return { ok: false, mensaje: `${cita.fields.Especialista} no está disponible.` };
        }
      }
    }
    return { ok: true, especialista: especialistaSolicitado || 'Asignar' };
  } catch (error) {
    return { ok: true, especialista: especialistaSolicitado };
  }
}

async function buscarAlternativaAirtable(fecha, horaSolicitada, especialistaSolicitado, duracion) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    const ocupados = response.data.records.map(c => ({
      hora: c.fields.Hora,
      duracion: c.fields['Duración estimada (minutos)'] || 60,
      especialista: c.fields.Especialista
    }));
    const [h, m] = horaSolicitada.split(':').map(Number);
    let horaPropuesta = h * 60 + m;
    while (horaPropuesta <= 1080 - duracion) {
      let conflicto = false;
      for (const ocup of ocupados) {
        const [ho, mo] = ocup.hora.split(':').map(Number);
        if (horaPropuesta < (ho * 60 + mo + ocup.duracion) && (horaPropuesta + duracion) > (ho * 60 + mo)) {
          if (!especialistaSolicitado || ocup.especialista === especialistaSolicitado) {
            conflicto = true; break;
          }
        }
      }
      if (!conflicto) {
        const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
        return { mensaje: `¿Te funciona a las ${horaStr}?`, hora: horaStr };
      }
      horaPropuesta += 15;
    }
    return { mensaje: "Ese día está completo." };
  } catch (error) {
    return { mensaje: "¿Te funciona otro horario?" };
  }
}
