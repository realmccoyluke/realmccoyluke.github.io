(() => {
  'use strict'

  const INITIAL_MAP_CENTER = [39.5, -98.35]
  const SEGMENT_COLORS = [
    '#47794a', '#3478b5', '#e28a35', '#8561a8', '#168c83', '#d85858',
    '#9a8b28', '#52677c', '#b34f82', '#7a6a3c', '#23849c', '#825247',
  ]
  const MILE_IN_KM = 1.609344
  const elements = {
    map: document.getElementById('course-map'),
    mapWrap: document.getElementById('map-wrap'),
    drawButton: document.getElementById('draw-button'),
    undoButton: document.getElementById('undo-button'),
    doneButton: document.getElementById('done-button'),
    instructions: document.getElementById('map-instructions-text'),
    message: document.getElementById('map-message'),
    distanceBadge: document.getElementById('map-distance'),
    legend: document.getElementById('map-legend'),
    waypointCount: document.getElementById('waypoint-count'),
    unit: document.getElementById('distance-unit'),
    courseDistance: document.getElementById('course-distance'),
    courseLengthNote: document.getElementById('course-length-note'),
    clock: document.getElementById('race-clock'),
    timerButton: document.getElementById('timer-button'),
    timerLiveDot: document.getElementById('timer-live-dot'),
    resetButton: document.getElementById('reset-button'),
    runnerPosition: document.getElementById('runner-position'),
    positionBadge: document.getElementById('position-badge'),
    trackButton: document.getElementById('track-button'),
    estimateCard: document.getElementById('estimate-card'),
    estimateTime: document.getElementById('estimate-time'),
    estimateFoot: document.getElementById('estimate-foot-text'),
    estimateFullscreenButton: document.getElementById('estimate-fullscreen-button'),
    estimateFullscreenStatus: document.getElementById('estimate-fullscreen-status'),
    searchForm: document.getElementById('search-form'),
    searchInput: document.getElementById('map-search'),
    searchSubmit: document.getElementById('search-submit'),
    suggestions: document.getElementById('location-suggestions'),
    locateButton: document.getElementById('locate-button'),
  }

  const state = {
    points: [],
    mode: null,
    selectedRunner: null,
    unit: 'km',
    elapsedBase: 0,
    timerStartedAt: null,
    clockNow: Date.now(),
    mapMessage: '',
    suggestions: [],
    activeSuggestion: 0,
    searchTimer: null,
    searchController: null,
    selectedLocationQuery: '',
  }
  let lastCourseRenderKey = null

  const map = L.map(elements.map, { scrollWheelZoom: true }).setView(INITIAL_MAP_CENTER, 4)
  const courseLayer = L.layerGroup().addTo(map)
  L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
  }).addTo(map)
  map.on('click', handleMapClick)

  function distanceBetween(first, second) {
    const radians = (degrees) => degrees * (Math.PI / 180)
    const [lat1, lon1] = first
    const [lat2, lon2] = second
    const deltaLat = radians(lat2 - lat1)
    const deltaLon = radians(lon2 - lon1)
    const a = Math.sin(deltaLat / 2) ** 2 +
      Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2
    const clampedA = Math.max(0, Math.min(1, a))
    return 6371 * 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA))
  }

  function totalDistanceKm() {
    return state.points.slice(1).reduce(
      (sum, point, index) => sum + distanceBetween(state.points[index], point),
      0,
    )
  }

  function buildCourseSegments(points, segmentLengthKm) {
    if (points.length < 2 || !Number.isFinite(segmentLengthKm) || segmentLengthKm <= 0) return []
    const cumulativeDistances = [0]
    for (let index = 1; index < points.length; index += 1) {
      cumulativeDistances.push(
        cumulativeDistances[index - 1] + distanceBetween(points[index - 1], points[index]),
      )
    }
    const totalKm = cumulativeDistances[cumulativeDistances.length - 1]
    const segmentCount = Math.ceil(totalKm / segmentLengthKm)
    const positionAt = (distanceKm) => {
      for (let index = 1; index < cumulativeDistances.length; index += 1) {
        if (cumulativeDistances[index] >= distanceKm) {
          const startKm = cumulativeDistances[index - 1]
          const segmentKm = cumulativeDistances[index] - startKm
          const fraction = segmentKm === 0 ? 0 : (distanceKm - startKm) / segmentKm
          return [
            points[index - 1][0] + (points[index][0] - points[index - 1][0]) * fraction,
            points[index - 1][1] + (points[index][1] - points[index - 1][1]) * fraction,
          ]
        }
      }
      return points[points.length - 1]
    }

    return Array.from({ length: segmentCount }, (_, index) => {
      const startKm = index * segmentLengthKm
      const endKm = Math.min((index + 1) * segmentLengthKm, totalKm)
      const positions = [positionAt(startKm)]
      points.forEach((point, pointIndex) => {
        const pointKm = cumulativeDistances[pointIndex]
        if (pointKm > startKm && pointKm < endKm) positions.push(point)
      })
      positions.push(positionAt(endKm))
      return {
        index,
        positions,
        color: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
      }
    })
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
    const rounded = Math.round(seconds)
    const hours = Math.floor(rounded / 3600)
    const minutes = Math.floor((rounded % 3600) / 60)
    const remainder = rounded % 60
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${minutes}:${String(remainder).padStart(2, '0')}`
  }

  function elapsedSeconds() {
    return state.elapsedBase + (state.timerStartedAt === null
      ? 0
      : (state.clockNow - state.timerStartedAt) / 1000)
  }

  function renderCourse() {
    const renderKey = JSON.stringify([state.unit, state.points, state.selectedRunner])
    if (renderKey === lastCourseRenderKey) return
    lastCourseRenderKey = renderKey
    courseLayer.clearLayers()
    const segmentLengthKm = state.unit === 'km' ? 1 : MILE_IN_KM
    const segments = buildCourseSegments(state.points, segmentLengthKm)
    segments.forEach((segment) => {
      L.polyline(segment.positions, {
        color: segment.color,
        weight: 6,
        opacity: 0.95,
      }).bindTooltip(`${state.unit === 'km' ? 'Kilometer' : 'Mile'} ${segment.index + 1}`, {
        sticky: true,
      }).addTo(courseLayer)
    })
    if (state.points.length > 0) {
      L.circleMarker(state.points[0], {
        radius: 7, color: '#315b3a', weight: 3, fillColor: '#ffffff', fillOpacity: 1,
      }).bindTooltip('START', { permanent: true, direction: 'top', offset: [0, -7] }).addTo(courseLayer)
    }
    if (state.points.length > 1) {
      L.circleMarker(state.points[state.points.length - 1], {
        radius: 7, color: '#315b3a', weight: 3, fillColor: '#b5d66e', fillOpacity: 1,
      }).bindTooltip('FINISH', { permanent: true, direction: 'top', offset: [0, -7] }).addTo(courseLayer)
      if (state.selectedRunner) {
        L.circleMarker(state.selectedRunner.point, {
          radius: 7, color: '#dc8d36', weight: 3, fillColor: '#ffffff', fillOpacity: 1,
        }).addTo(courseLayer)
      }
    }

    elements.legend.querySelectorAll('.segment-key-item, .runner-key').forEach((item) => item.remove())
    segments.forEach((segment) => {
      const item = document.createElement('span')
      item.className = 'segment-key-item'
      const line = document.createElement('i')
      line.className = 'legend-line'
      line.style.backgroundColor = segment.color
      item.append(line, document.createTextNode(`${state.unit === 'km' ? 'Km' : 'Mile'} ${segment.index + 1}`))
      elements.legend.insertBefore(item, elements.waypointCount)
    })
    const runnerKey = document.createElement('span')
    runnerKey.className = 'runner-key'
    runnerKey.innerHTML = '<i class="legend-split"></i> Runner'
    elements.legend.insertBefore(runnerKey, elements.waypointCount)
    elements.waypointCount.textContent = `${state.points.length} points`
  }

  function renderSearchSuggestions() {
    const query = elements.searchInput.value.trim()
    const open = query.length >= 2 && elements.searchInput.getAttribute('aria-expanded') === 'true'
    elements.suggestions.hidden = !open
    if (!open) {
      elements.suggestions.replaceChildren()
      return
    }
    if (state.suggestions.length === 0) {
      const status = document.createElement('div')
      status.className = 'location-search-state'
      status.setAttribute('role', 'status')
      status.textContent = elements.searchSubmit.disabled
        ? 'Searching locations…'
        : state.mapMessage.startsWith('Place search failed')
          ? 'Could not load locations. Try again.'
          : 'No locations found. Try a nearby town, park, or address.'
      elements.suggestions.replaceChildren(status)
      return
    }

    const list = document.createElement('ul')
    list.id = 'location-suggestion-options'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Matching locations')
    state.suggestions.forEach((result, index) => {
      const li = document.createElement('li')
      const button = document.createElement('button')
      button.id = `location-option-${index}`
      button.className = `location-option${state.activeSuggestion === index ? ' is-active' : ''}`
      button.type = 'button'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(state.activeSuggestion === index))
      const icon = document.createElement('span')
      icon.className = 'location-option-icon'
      icon.textContent = '⌖'
      const text = document.createElement('span')
      text.className = 'location-option-text'
      const name = document.createElement('strong')
      name.textContent = result.name || result.display_name.split(',')[0]
      const context = document.createElement('small')
      context.textContent = result.display_name.split(',').slice(1).map((part) => part.trim()).join(', ') || result.type
      text.append(name, context)
      button.append(icon, text)
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('mouseenter', () => {
        state.activeSuggestion = index
        list.querySelectorAll('[role="option"]').forEach((option, optionIndex) => {
          option.classList.toggle('is-active', optionIndex === index)
          option.setAttribute('aria-selected', String(optionIndex === index))
        })
        elements.searchInput.setAttribute('aria-activedescendant', button.id)
      })
      button.addEventListener('click', () => selectLocation(result))
      li.append(button)
      list.append(li)
    })
    elements.suggestions.replaceChildren(list)
    elements.searchInput.setAttribute('aria-controls', list.id)
    elements.searchInput.setAttribute('aria-activedescendant', `location-option-${state.activeSuggestion}`)
  }

  function render() {
    const distanceKm = totalDistanceKm()
    const total = distanceKm / (state.unit === 'km' ? 1 : MILE_IN_KM)
    const selectedKm = state.selectedRunner ? state.selectedRunner.distanceKm : null
    const selectedDistance = selectedKm === null
      ? null
      : selectedKm / (state.unit === 'km' ? 1 : MILE_IN_KM)
    const elapsed = elapsedSeconds()
    const estimated = selectedKm !== null && selectedKm > 0 && selectedKm < distanceKm && elapsed > 0
      ? (elapsed / selectedKm) * distanceKm
      : null

    elements.mapWrap.classList.toggle('is-draw', state.mode === 'draw')
    elements.mapWrap.classList.toggle('is-track', state.mode === 'track')
    elements.drawButton.hidden = state.mode === 'draw'
    elements.undoButton.hidden = state.mode !== 'draw'
    elements.doneButton.hidden = state.mode !== 'draw'
    elements.undoButton.disabled = state.points.length === 0
    elements.doneButton.disabled = state.points.length < 2
    elements.instructions.textContent = state.mode === 'draw'
      ? 'Click the map to trace your course'
      : state.mode === 'track'
        ? 'Click the course near the runner’s current position'
        : 'Search, zoom, or drag to find your course'

    elements.courseDistance.textContent = state.points.length < 2 ? '—' : `${total.toFixed(2)} ${state.unit}`
    elements.courseLengthNote.textContent = state.points.length < 2
      ? 'Draw a route to calculate length'
      : `Colors change every 1 ${state.unit === 'km' ? 'km' : 'mi'}`
    elements.distanceBadge.lastElementChild.textContent = state.points.length < 2
      ? 'Draw a course to measure'
      : `${total.toFixed(2)} ${state.unit}`
    elements.clock.textContent = formatTime(Math.floor(elapsed))
    elements.timerLiveDot.classList.toggle('is-live', state.timerStartedAt !== null)
    elements.timerButton.textContent = state.timerStartedAt !== null
      ? 'Pause timer'
      : elapsed > 0 ? 'Resume timer' : 'Start race timer'
    elements.timerButton.disabled = state.points.length < 2
    elements.resetButton.disabled = elapsed === 0 && state.selectedRunner === null
    elements.runnerPosition.textContent = selectedDistance === null
      ? 'Not marked yet'
      : `${selectedDistance.toFixed(2)} ${state.unit} into course`
    elements.positionBadge.hidden = !state.selectedRunner
    elements.trackButton.disabled = state.points.length < 2
    elements.trackButton.className = `button ${state.mode === 'track' ? 'button-quiet' : 'button-location'}`
    elements.trackButton.textContent = state.mode === 'track'
      ? '⌖ Cancel selection'
      : '⌖ Select position on course'
    elements.estimateTime.textContent = estimated === null ? '--:--' : formatTime(estimated)
    elements.estimateFoot.textContent = estimated === null || selectedDistance === null
      ? 'Start timer and mark a runner'
      : `${formatTime(elapsed / selectedDistance)} / ${state.unit} average pace`
    elements.message.textContent = state.mapMessage
    elements.message.hidden = !state.mapMessage
    renderCourse()
  }

  function closestPointOnCourse(clicked) {
    const clickedLayerPoint = map.latLngToLayerPoint(clicked)
    let closest = null
    let cumulativeDistance = 0
    for (let index = 0; index < state.points.length - 1; index += 1) {
      const start = map.latLngToLayerPoint(state.points[index])
      const end = map.latLngToLayerPoint(state.points[index + 1])
      const dx = end.x - start.x
      const dy = end.y - start.y
      const lengthSquared = dx * dx + dy * dy
      const fraction = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((clickedLayerPoint.x - start.x) * dx +
          (clickedLayerPoint.y - start.y) * dy) / lengthSquared))
      const x = start.x + fraction * dx
      const y = start.y + fraction * dy
      const distanceSquared = (clickedLayerPoint.x - x) ** 2 + (clickedLayerPoint.y - y) ** 2
      if (closest === null || distanceSquared < closest.distanceSquared) {
        const projected = map.layerPointToLatLng(L.point(x, y))
        closest = {
          distanceSquared,
          point: [projected.lat, projected.lng],
          distanceKm: cumulativeDistance + distanceBetween(state.points[index], state.points[index + 1]) * fraction,
        }
      }
      cumulativeDistance += distanceBetween(state.points[index], state.points[index + 1])
    }
    return closest
  }

  function handleMapClick(event) {
    if (state.mode === 'draw') {
      state.points.push([event.latlng.lat, event.latlng.lng])
      render()
      return
    }
    if (state.mode !== 'track' || state.points.length < 2) return
    const closest = closestPointOnCourse(event.latlng)
    if (closest === null || closest.distanceSquared > 75 ** 2) {
      state.mapMessage = 'Click closer to the course line to mark the runner.'
    } else {
      state.selectedRunner = { point: closest.point, distanceKm: closest.distanceKm }
      state.mode = null
      state.mapMessage = ''
    }
    render()
  }

  function pauseTimer() {
    if (state.timerStartedAt === null) return
    state.elapsedBase += (Date.now() - state.timerStartedAt) / 1000
    state.timerStartedAt = null
  }

  function startDrawing() {
    pauseTimer()
    state.points = []
    state.selectedRunner = null
    state.mode = 'draw'
    state.mapMessage = ''
    render()
  }

  function selectLocation(result) {
    state.selectedLocationQuery = result.display_name
    state.suggestions = []
    elements.searchInput.value = result.display_name
    elements.searchInput.setAttribute('aria-expanded', 'false')
    state.mapMessage = result.display_name
    map.flyTo([Number(result.lat), Number(result.lon)], 15, { duration: 0.8 })
    render()
    renderSearchSuggestions()
  }

  async function searchLocations(query) {
    if (state.searchController) state.searchController.abort()
    const controller = new AbortController()
    state.searchController = controller
    elements.searchSubmit.disabled = true
    elements.searchSubmit.textContent = 'Searching…'
    state.suggestions = []
    renderSearchSuggestions()
    try {
      const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5' })
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Place search failed (${response.status}). Please try again.`)
      const results = await response.json()
      if (!Array.isArray(results)) throw new Error('Place search returned an invalid response. Please try again.')
      if (controller.signal.aborted) return
      state.suggestions = results
      state.activeSuggestion = 0
      state.mapMessage = ''
    } catch (error) {
      if (controller.signal.aborted) return
      state.suggestions = []
      state.mapMessage = error instanceof Error ? error.message : 'Place search failed. Please try again.'
    } finally {
      if (!controller.signal.aborted) {
        elements.searchSubmit.disabled = false
        elements.searchSubmit.textContent = 'Search'
        render()
        renderSearchSuggestions()
      }
    }
  }

  elements.drawButton.addEventListener('click', startDrawing)
  elements.undoButton.addEventListener('click', () => {
    state.points.pop()
    render()
  })
  elements.doneButton.addEventListener('click', () => {
    state.mode = null
    render()
  })
  elements.unit.addEventListener('change', () => {
    state.unit = elements.unit.value
    render()
  })
  elements.timerButton.addEventListener('click', () => {
    if (state.timerStartedAt !== null) {
      pauseTimer()
    } else {
      state.clockNow = Date.now()
      state.timerStartedAt = state.clockNow
    }
    render()
  })
  elements.resetButton.addEventListener('click', () => {
    state.timerStartedAt = null
    state.elapsedBase = 0
    state.clockNow = Date.now()
    state.selectedRunner = null
    render()
  })
  elements.trackButton.addEventListener('click', () => {
    state.mapMessage = ''
    state.mode = state.mode === 'track' ? null : 'track'
    render()
  })
  elements.estimateFullscreenButton.addEventListener('click', async () => {
    elements.estimateFullscreenStatus.textContent = ''
    try {
      if (document.fullscreenElement === elements.estimateCard) {
        await document.exitFullscreen()
      } else if (typeof elements.estimateCard.requestFullscreen === 'function' &&
        document.fullscreenEnabled !== false) {
        await elements.estimateCard.requestFullscreen()
      } else {
        elements.estimateFullscreenStatus.textContent = 'Fullscreen is not available in this browser.'
        return
      }
    } catch (error) {
      console.error('Unable to display the estimated finish time in fullscreen.', error)
      elements.estimateFullscreenStatus.textContent =
        'Could not enter fullscreen. Check your browser settings.'
    }
  })
  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = document.fullscreenElement === elements.estimateCard
    elements.estimateFullscreenButton.textContent = isFullscreen ? '↙' : '↗'
    const label = isFullscreen
      ? 'Exit fullscreen estimated finish time'
      : 'Show estimated finish time in fullscreen'
    elements.estimateFullscreenButton.setAttribute('aria-label', label)
    elements.estimateFullscreenButton.title = label
  })
  elements.searchForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const query = elements.searchInput.value.trim()
    if (query.length < 2) return
    elements.searchInput.setAttribute('aria-expanded', 'true')
    if (state.searchTimer !== null) clearTimeout(state.searchTimer)
    searchLocations(query)
  })
  elements.searchInput.addEventListener('input', () => {
    const query = elements.searchInput.value.trim()
    state.selectedLocationQuery = ''
    state.suggestions = []
    state.mapMessage = ''
    elements.searchInput.setAttribute('aria-expanded', String(query.length >= 2))
    elements.searchInput.removeAttribute('aria-activedescendant')
    if (state.searchTimer !== null) clearTimeout(state.searchTimer)
    if (state.searchController) state.searchController.abort()
    elements.searchSubmit.disabled = query.length < 2
    elements.searchSubmit.textContent = query.length >= 2 ? 'Searching…' : 'Search'
    renderSearchSuggestions()
    if (query.length >= 2) state.searchTimer = setTimeout(() => searchLocations(query), 350)
  })
  elements.searchInput.addEventListener('focus', () => {
    if (elements.searchInput.value.trim().length >= 2) {
      elements.searchInput.setAttribute('aria-expanded', 'true')
      renderSearchSuggestions()
    }
  })
  elements.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      elements.searchInput.setAttribute('aria-expanded', 'false')
      renderSearchSuggestions()
      return
    }
    if (state.suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      state.activeSuggestion = (state.activeSuggestion + 1) % state.suggestions.length
      renderSearchSuggestions()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      state.activeSuggestion = (state.activeSuggestion - 1 + state.suggestions.length) % state.suggestions.length
      renderSearchSuggestions()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectLocation(state.suggestions[state.activeSuggestion])
    }
  })
  elements.locateButton.addEventListener('click', () => {
    if (!navigator.geolocation) {
      state.mapMessage = 'Location is not available in this browser.'
      render()
      return
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        map.flyTo([coords.latitude, coords.longitude], 15, { duration: 0.8 })
        state.mapMessage = 'Showing your current location.'
        render()
      },
      (error) => {
        state.mapMessage = error.code === error.PERMISSION_DENIED
          ? 'Location access was denied. Search for a place instead.'
          : 'Could not determine your location. Search for a place instead.'
        render()
      },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  })

  window.setInterval(() => {
    state.clockNow = Date.now()
    if (state.timerStartedAt !== null) render()
  }, 250)

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => map.invalidateSize({ animate: false, pan: false })).observe(elements.map)
  } else {
    window.addEventListener('resize', () => map.invalidateSize({ animate: false, pan: false }))
  }

  elements.searchSubmit.disabled = true
  render()
})()
