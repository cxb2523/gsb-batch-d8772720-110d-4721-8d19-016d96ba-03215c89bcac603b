import React, { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic'
import type { DevicePlotProps } from './DevicePlot'
import {
  FieldDataCollector,
  FIELDS,
  initialFieldState,
} from './fieldData'
import type { FieldDataState, FieldName } from './fieldData'

/* Wrap DevicePlot with a dynamic import to disable server-side rendering.
 * Prevents `self is undefined` errors caused by Giraffe when rendered
 * with Node.
 */
const DynamicDevicePlotWithNoSSR = dynamic<DevicePlotProps>(
  () => import('./DevicePlot').then(mod => mod.DevicePlot),
  { ssr: false }
)

export function Device({deviceId}: {deviceId: string | string[]}) {
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [device, setDevice] = useState<any[] | null>(null)
  /* One independent state entry per field (Humidity/Pressure/Temperature). */
  const [fieldData, setFieldData] = useState<FieldDataState>(initialFieldState)
  deviceId = Array.isArray(deviceId) ? deviceId[0] : deviceId

  const collectorRef = useRef<FieldDataCollector | null>(null)
  if (collectorRef.current === null) {
    collectorRef.current = new FieldDataCollector(setFieldData)
  }
  const collector = collectorRef.current

  useEffect(() => {
    /* Switching devices: discard the previous device's in-flight results and
     * reset every field before anything for the new device is requested. */
    setDevice(null)
    setError(null)
    setIsLoading(false)
    collector.invalidateSession()

    if (!deviceId) {
      return
    }

    let cancelled = false
    setIsLoading(true)

    fetch(`/api/devices/${deviceId}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) {
          return
        }
        if (Array.isArray(data)) {
          setDevice(data)
          /* Device metadata arrived: start the three independent field
           * requests. A stale session (another switch) drops every result. */
          collector.collectAll(deviceId as string)
        }
        if (data.error) {
          setError(data.error)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(`Failed to load device ${deviceId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
      /* Unmount or another switch: invalidate so late responses are dropped. */
      collector.invalidateSession()
    }
  }, [deviceId, collector])

  /* Retry a single field; other fields are not requested again. */
  function retryField(field: FieldName) {
    if (deviceId) {
      collector.collectField(deviceId as string, field)
    }
  }

  /* Write simulated data first; only when the write succeeds do we
   * re-collect all three fields. On failure the existing charts stay and
   * the write error is shown. */
  function writeSimulatedData() {
    setError(null)
    fetch('/api/devices/generate', {
      method: 'POST',
      body: JSON.stringify({ deviceIds: [deviceId] }),
      headers: { 'Content-Type': 'application/json' },
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Writing data: ${res.status} ${res.statusText}`.trim())
        }
        collector.collectAll(deviceId as string)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : `Writing data: ${String(err)}`)
      })
  }

  return (
      <div>
        <div className="alert">
        { isLoading && <span>Loading...</span> }
        { error &&
          <span className="alert-danger">{ error }</span>
        }
        </div>
        <h5>Device</h5>
        {device && <h4>{deviceId}</h4>}
        {device &&
          <p><button onClick={ writeSimulatedData }>Generate data for this device</button></p>
        }
        {FIELDS.map((field) => {
          const fieldState = fieldData[field]
          return (
            <div className='card-body' key={field} aria-label={`${field} measurements`}>
              <h3>{field}</h3>
              { fieldState.status === 'loading' &&
                <span>Loading {field}...</span>
              }
              { fieldState.status === 'error' &&
                <div className="alert">
                  <span className="alert-danger">{ fieldState.error }</span>{' '}
                  <button onClick={() => retryField(field)}>Retry {field}</button>
                </div>
              }
              { fieldState.status === 'success' &&
                <div>
                  <div><DynamicDevicePlotWithNoSSR csv={fieldState.csv} plot='line' title='' /></div>
                  <div><DynamicDevicePlotWithNoSSR csv={fieldState.csv} plot='table' title='' /></div>
                </div>
              }
            </div>
          )
        })}
      </div>
  )
}
