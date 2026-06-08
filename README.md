# Protocol Timer PWA v4

スマホ/iPad向けのPWA版です。App Storeを使わず、Safari/Chromeからホーム画面に追加して使うことを想定しています。

## ローカルで試す

PCで以下を実行します。

```bash
npm install
npm run dev
```

表示されたURLを開きます。

同じWi-Fi内のiPhone/iPadから試す場合は、PCのIPアドレスで開きます。

例:

```text
http://192.168.1.10:5173/
```

ただし、Service WorkerやPWAの一部機能はHTTPSでないと有効にならないことがあります。

## iPhone/iPadでホーム画面に追加

HTTPSで公開したURLをSafariで開きます。

```text
共有ボタン
↓
ホーム画面に追加
```

## 公開方法

GitHub Pages / Netlify / Vercel など、HTTPSで配信できる場所に置いてください。

このzipには GitHub Pages 用のworkflowも入れています。

```text
.github/workflows/deploy-pages.yml
```

## スマホ版の制約

- 実験中は画面を開いたまま使うのがおすすめです。
- 画面ロック中やバックグラウンド中のアラームはiOS側の制限を受けます。
- 音声出力先の細かい選択はiOS側に任せます。
- プロトコルやログはlocalStorage、JSON/CSV/HTMLのエクスポート/インポートで扱います。

## 残している主な機能

- プロトコル作成
- 実験実行
- 複数実験の並行管理
- 一括操作
- Start / Pause / Resume / Finish / Reset
- Extend / Shorten
- Skip理由入力
- アラーム
- 1分前通知
- CSV / HTML / JSON出力
- PWA manifest
- Service Worker


## v2 修正点

- GitHub Actions の `npm run build` で TypeScript の `moduleResolution=node10` 警告がエラーになる問題を修正
- `tsconfig.json` の `moduleResolution` を `bundler` に変更
- `ignoreDeprecations: "6.0"` を追加


## v3 修正点

- GitHub Actions の TypeScript build エラーを修正
- `@types/react` と `@types/react-dom` を追加
- CSS import 用に `src/vite-env.d.ts` を追加
- `lib` を `ES2021` に変更して `replaceAll` に対応
- GitHub Pages公開時に型チェックで止まりにくいよう `strict` を無効化


## v4 修正点

- GitHub Pagesのサブパス配信で真っ白になる問題を修正
- `vite.config.ts` を追加し、`base: "./"` に設定
- manifest / icon / service worker のパスを相対パスに変更
