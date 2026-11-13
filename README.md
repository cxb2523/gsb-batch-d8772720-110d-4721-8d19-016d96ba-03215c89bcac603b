# UI for iot-api tutorials

This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app) and
customized to route `/api` requests to external middleware -
specifically, the InfluxData `iot-app-<js, python, etc.>` example applications.

## Start the Next.js frontend app

1. Run the development server:

   ```bash
   npm run dev
   # or
   yarn dev
   ```

  By default, the server runs on port `:3000`; otherwise, the next available port (for example, `3001`).
  Visit [http://localhost:3000](http://localhost:3000) in your browser to see the result.

  To view the IoT Starter device dashboard, visit [http://localhost:3000/devices/](http://localhost:3000/devices/)

1. To customize the UI default page, edit the `pages/index.tsx` file. The page auto-updates as you edit the file.

Next.js provides a sample REST API at [http://localhost:3000/api/hello](http://localhost:3000/api/hello). To customize the sample endpoints, edit `pages/api/hello.ts`.

View IoT Starter devices at [http://localhost:3000/devices/](http://localhost:3000/devices/).
To customize the device pages, edit the files located in [`./pages/devices`](./pages/devices/).

## Use with `iot-api-[language]` apps

To use the UI with one of the `iot-api-[language]` example apps, set `API_URL` in `./.env.development` to the URL of the API example app.

The UI automatically routes all `/api/` requests to your API server.
`iot-api-ui` uses Next.js' _catch-all_ routing and [**`rewrites`** module](https://nextjs.org/docs/pages/api-reference/next-config-js/rewrites) to act as a proxy for cross-domain requests to the server.
To customize the URL rewrites, edit `next.config.js`.

## Per-field measurement collection & local acceptance testing

The device detail page collects the three fields (`Humidity`, `Pressure`,
`Temperature`) independently. Each field has its own
`POST /api/devices/{deviceId}/measurements` request (JSON body containing the
Flux query, `Accept: application/csv`), its own line chart and table labelled
with the field name, and its own success/error state. A failed field shows a
field-named error with a **Retry** button that re-requests only that field.
Switching devices discards all in-flight results of the previous device, and
re-triggering a field keeps only the last request's result. The collection
logic lives in [`components/devices/fieldData.ts`](./components/devices/fieldData.ts).

Two zero-dependency test layers use only the Node standard library:

```bash
# Unit tests for the collector (stale sessions, last-request-wins, per-field retry)
npm test

# End-to-end acceptance against a locally mocked backend (starts its own server)
npm run acceptance
```

To drive the real UI by hand, run the mock API and point the dev server at it:

```bash
npm run mock-api            # http://localhost:4010, devices device-alpha / device-beta
API_URL=http://localhost:4010 npm run dev
```

The mock exposes `POST /__control` to script failure scenarios:

```bash
# Make only Pressure return 502 (the other fields stay 200)
curl -X POST http://localhost:4010/__control -H 'Content-Type: application/json' \
  -d '{"pressureFail": true}'
# Make the write-data endpoint fail (existing charts must remain)
curl -X POST http://localhost:4010/__control -H 'Content-Type: application/json' \
  -d '{"generateFail": true}'
# Add latency to Pressure so a device switch can overtake an in-flight request
curl -X POST http://localhost:4010/__control -H 'Content-Type: application/json' \
  -d '{"pressureDelayMs": 400}'
```

## Learn More

Follow step-by-step tutorials to build the IoT Starter app:

- [InfluxDB OSS v2 Python and JavaScript tutorials](https://docs.influxdata.com/influxdb/v2/api-guide/tutorials/)
- [InfluxDB Cloud v2 Python and JavaScript tutorials](https://docs.influxdata.com/influxdb/cloud/api-guide/tutorials/)

To learn more about Next.js, see following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
