import type { AppProps } from 'next/app'
import Layout from './_layout'
import 'bootstrap/dist/css/bootstrap.css'

export default function IotStarter({ Component, pageProps }: AppProps) {
  return (
    <Layout>
      <Component {...pageProps} />
    </Layout>
  )
}