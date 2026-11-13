import Head from 'next/head'
import type { ReactNode } from 'react'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className={'container'}>
      <Head>
        <title>IoT Starter</title>
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={'main'}>{children}</main>

      <footer>
      </footer>
    </div>
  )
}
