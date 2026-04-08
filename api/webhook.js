// ============ FUNCIÓN CENTRAL DE ACCIONES ============

async function procesarAccionCita(datos, cliente, telefono, especialistasLista, serviciosLista) {
  console.log(`\n🎯 PROCESANDO ACCIÓN: ${datos.accion?.toUpperCase() || 'DESCONOCIDA'}`);
  console.log(`👤 Cliente: ${cliente?.nombre} ${cliente?.apellido} (ID: ${cliente?.id})`);
  
  const resultado = { exito: false, mensaje: '', error: null };

  try {
    if (!datos || typeof datos !== 'object') {
      return { ...resultado, mensaje: 'Datos de acción inválidos.' };
    }

    if (!datos.accion) {
      return { ...resultado, mensaje: 'No detecté qué acción quieres realizar.' };
    }

    if (!especialistasLista || !Array.isArray(especialistasLista) || especialistasLista.length === 0) {
      console.error('❌ ERROR: especialistasLista vacía');
      return { ...resultado, mensaje: 'Error al cargar especialistas.' };
    }

    if (!serviciosLista || !Array.isArray(serviciosLista) || serviciosLista.length === 0) {
      console.error('❌ ERROR: serviciosLista vacía');
      return { ...resultado, mensaje: 'Error al cargar servicios.' };
    }

    // ----- AGENDAR -----
    if (datos.accion === 'agendar') {
      console.log('📋 Datos agendar:', {
        fecha: datos.cita_fecha,
        hora: datos.cita_hora,
        servicio: datos.cita_servicio,
        especialista: datos.cita_especialista
      });

      if (!datos.cita_fecha || datos.cita_fecha === "..." || 
          !datos.cita_hora || datos.cita_hora === "...") {
        return { ...resultado, mensaje: 'Necesito la fecha y hora específica para agendar tu cita.' };
      }

      // Buscar servicio
      let servicio = null;
      if (datos.cita_servicio && datos.cita_servicio !== "...") {
        const busquedaServicio = datos.cita_servicio.toLowerCase().trim();
        servicio = serviciosLista.find(s => 
          s.nombre && (
            s.nombre.toLowerCase().includes(busquedaServicio) ||
            busquedaServicio.includes(s.nombre.toLowerCase())
          )
        );
      }

      // Buscar especialista
      let especialista = null;
      if (datos.cita_especialista && datos.cita_especialista !== "...") {
        const busquedaEsp = datos.cita_especialista.toLowerCase().trim();
        especialista = especialistasLista.find(e => 
          e.nombre && (
            e.nombre.toLowerCase().includes(busquedaEsp) ||
            busquedaEsp.includes(e.nombre.toLowerCase())
          )
        );
      }

      console.log('🔍 Búsqueda resultados:', {
        servicioBuscado: datos.cita_servicio,
        servicioEncontrado: servicio?.nombre || 'NO',
        especialistaBuscado: datos.cita_especialista,
        especialistaEncontrado: especialista?.nombre || 'NO'
      });

      if (!servicio) {
        const disponibles = serviciosLista.map(s => s.nombre).join(', ');
        return { ...resultado, mensaje: `No encontré el servicio "${datos.cita_servicio}". Disponibles: ${disponibles}` };
      }

      if (!especialista) {
        const disponibles = especialistasLista.map(e => e.nombre).join(', ');
        if (!datos.cita_especialista || datos.cita_especialista === '...') {
          return { ...resultado, mensaje: `¿Con qué especialista prefieres atenderte? Tenemos: ${disponibles}` };
        }
        return { ...resultado, mensaje: `No encontré al especialista "${datos.cita_especialista}". Disponibles: ${disponibles}` };
      }

      // Verificar disponibilidad
      console.log('🔍 Verificando disponibilidad...');
      const disponible = await verificarDisponibilidadRobusta(
        datos.cita_fecha, 
        datos.cita_hora, 
        especialista.id, 
        servicio.duracion
      );

      if (!disponible.ok) {
        return { ...resultado, mensaje: disponible.mensaje };
      }

      // CREAR CITA EN SUPABASE - CORREGIDO: columna "precio" no "precio_aux"
      console.log('💾 Creando cita en Supabase...');
      const fechaHoraISO = `${datos.cita_fecha}T${datos.cita_hora}:00-05:00`;
      
      const { data: citaCreada, error: errorCita } = await supabase
        .from('citas')
        .insert({
          cliente_id: cliente.id,
          servicio_id: servicio.id,
          especialista_id: especialista.id,
          fecha_hora: fechaHoraISO,
          estado: 'Confirmada',
          nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido}`.trim(),
          servicio_aux: servicio.nombre,
          duracion_aux: servicio.duracion,
          precio: servicio.precio,  // ← CORREGIDO: "precio" no "precio_aux"
          telefono_aux: telefono,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (errorCita) {
        console.error('❌ ERROR SUPABASE:', errorCita);
        throw new Error(`Error al guardar cita: ${errorCita.message}`);
      }

      if (!citaCreada || !citaCreada.id) {
        throw new Error('Supabase no retornó ID de cita');
      }

      console.log('✅ Cita creada en Supabase:', citaCreada.id);

      // SINCRONIZAR AIRTABLE
      console.log('☁️ Sincronizando con Airtable...');
      let airtableOk = false;
      try {
        const airtableRes = await axios.post(
          `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`,
          {
            records: [{
              fields: {
                "ID_Supabase": citaCreada.id,
                "Cliente": `${cliente.nombre} ${cliente.apellido}`.trim(),
                "Servicio": servicio.nombre,
                "Fecha": datos.cita_fecha,
                "Hora": datos.cita_hora,
                "Especialista": especialista.nombre,
                "Teléfono": telefono,
                "Estado": "Confirmada",
                "Importe estimado": servicio.precio,
                "Duración estimada (minutos)": servicio.duracion,
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
        
        if (airtableRes.data.records && airtableRes.data.records.length > 0) {
          console.log('✅ Sincronizado con Airtable:', airtableRes.data.records[0]?.id);
          airtableOk = true;
        }
      } catch (airtableError) {
        console.error('⚠️ ERROR AIRTABLE (cita SÍ está en Supabase):', airtableError.message);
      }

      return {
        exito: true,
        mensaje: `✅ *Cita Confirmada*\n\n📅 ${formatearFecha(datos.cita_fecha)} a las ${datos.cita_hora}\n💇‍♀️ ${servicio.nombre}\n👤 Con ${especialista.nombre}\n⏱️ ${servicio.duracion} minutos\n💰 $${servicio.precio}${!airtableOk ? '\n\n⚠️ (Sincronización pendiente)' : ''}\n\nTe espero con ganas de consentirte. ✨`,
        citaId: citaCreada.id
      };
    }

    // ----- REAGENDAR -----
    else if (datos.accion === 'reagendar') {
      if (!datos.cita_fecha || !datos.cita_hora) {
        return { ...resultado, mensaje: 'Necesito la nueva fecha y hora.' };
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
        return { ...resultado, mensaje: 'No encontré citas próximas para reprogramar.' };
      }

      const disponible = await verificarDisponibilidadRobusta(
        datos.cita_fecha,
        datos.cita_hora,
        citaActual.especialista_id,
        citaActual.duracion_aux || 60
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
        mensaje: `🔄 *Cita Reprogramada*\n\n"${citaActual.servicio_aux}" ahora:\n📅 ${formatearFecha(datos.cita_fecha)} a las ${datos.cita_hora}\n\n¡Nos vemos! ✨`
      };
    }

    // ----- CANCELAR -----
    else if (datos.accion === 'cancelar') {
      const { data: citaActual } = await supabase
        .from('citas')
        .select('id, servicio_aux, fecha_hora')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', new Date().toISOString())
        .order('fecha_hora', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!citaActual) {
        return { ...resultado, mensaje: 'No encontré citas próximas para cancelar.' };
      }

      const { error: cancelError } = await supabase
        .from('citas')
        .update({ 
          estado: 'Cancelada',
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
        mensaje: `🚫 *Cita Cancelada*\n\n"${citaActual.servicio_aux}" para el ${formatearFecha(citaActual.fecha_hora.split('T')[0])} cancelada.\n\n¿Agendamos otra? 💫`
      };
    }

    else {
      return { ...resultado, mensaje: 'Acción no reconocida. ¿Agendar, reprogramar o cancelar?' };
    }

  } catch (error) {
    console.error('❌ ERROR EN procesarAccionCita:', error);
    return {
      exito: false,
      mensaje: '⚠️ Error técnico. Intenta de nuevo.',
      error: error.message
    };
  }
}
