import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight,
  Instagram, LockKeyhole, Menu, Minus, Package, Plus, Search,
  ShoppingBag, SlidersHorizontal, Sparkles, Star, Trash2, Truck, UserRound, X,
} from 'lucide-react'
import ProductVisual from './ProductVisual'

type User = { id: number; name: string; email: string; role: string; address?: string; bio?: string }
type Session = { user: User | null; csrfToken: string }
type Product = { id: number; slug: string; name: string; category: string; price: number; stock: number; image: string; description: string; featured: boolean; accent?: string }
type Review = { id: number; authorName: string; rating: number; title: string; body: string; createdAt: string }
type CartItem = { id: number; productId: number; quantity: number; product: Product }
type Cart = { items: CartItem[]; subtotal: number }
type OrderItem = { productId: number; name: string; quantity: number; price: number }
type Order = { id: string; status: string; subtotal: number; shippingFee: number; total: number; createdAt: string; items: OrderItem[]; name: string; address: string; postalCode: string; method: string }
type Route = { path: string; query: URLSearchParams }

class HttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const client = {
  csrf: '',
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' || !this.csrf ? {} : { 'X-CSRF-Token': this.csrf }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new HttpError(data.error || '通信に失敗しました。時間をおいて再度お試しください。', response.status)
    return data as T
  },
}

const money = (amount: number | undefined) => '¥' + new Intl.NumberFormat('ja-JP').format(Number(amount || 0))
const date = (value: string | undefined) => value ? new Date(value).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
const emptyCart: Cart = { items: [], subtotal: 0 }

function currentRoute(): Route {
  const raw = window.location.hash.slice(1) || '/'
  const parsed = new URL(raw, window.location.origin)
  return { path: parsed.pathname, query: parsed.searchParams }
}

function useRoute() {
  const [route, setRoute] = useState<Route>(currentRoute)
  useEffect(() => {
    const onChange = () => {
      setRoute(currentRoute())
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

function go(path: string) {
  window.location.hash = '#' + path
}

function Link({ to, children, className = '', onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  return <a className={className} href={'#' + to} onClick={onClick}>{children}</a>
}

function Spinner() {
  return <div className="spinner" role="status" aria-label="読み込み中" />
}

function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state__icon">{icon}</div><h2>{title}</h2><p>{text}</p>{action}</div>
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="section-heading">
    <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{description && <p className="section-heading__description">{description}</p>}</div>
    {action}
  </div>
}

function ProductCard({ product, onAdd }: { product: Product; onAdd: (id: number) => void }) {
  return <article className="product-card">
    <Link to={'/product/' + product.id} className="product-card__image">
      <ProductVisual product={product} />
      <span className="product-card__arrow"><ArrowRight size={18} strokeWidth={1.7} /></span>
    </Link>
    <div className="product-card__body">
      <div>
        <span className="product-card__category">{product.category}</span>
        <Link to={'/product/' + product.id} className="product-card__name">{product.name}</Link>
        <strong>{money(product.price)}</strong>
      </div>
      <button type="button" className="round-icon-button product-card__add" onClick={() => onAdd(product.id)} aria-label={product.name + 'をカートに追加'} disabled={product.stock <= 0}><Plus size={19} strokeWidth={1.7} /></button>
    </div>
  </article>
}

function Header({ user, cartCount }: { user: User | null; cartCount: number }) {
  const [search, setSearch] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    go('/shop?q=' + encodeURIComponent(search.trim()))
    setMenuOpen(false)
    setSearchOpen(false)
  }
  return <>
    <div className="announcement">日々のかたちを、少しずつ整える。<span>Objects for the everyday</span></div>
    <header className="site-header">
      <div className="site-header__inner shell">
        <button className="mobile-menu-button icon-button" type="button" aria-label="メニューを開く" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={22} /> : <Menu size={22} />}</button>
        <Link to="/" className="wordmark" onClick={() => setMenuOpen(false)} aria-label="KOVA トップページ">KOVA<span>.</span></Link>
        <nav className={'main-nav ' + (menuOpen ? 'main-nav--open' : '')} aria-label="メインメニュー">
          <Link to="/shop" onClick={() => setMenuOpen(false)}>すべての商品</Link>
          <Link to="/shop?category=デスク" onClick={() => setMenuOpen(false)}>デスク</Link>
          <Link to="/shop?category=照明" onClick={() => setMenuOpen(false)}>照明</Link>
          <Link to="/shop?category=キッチン" onClick={() => setMenuOpen(false)}>キッチン</Link>
          {user?.role === 'staff' && <Link to="/staff" onClick={() => setMenuOpen(false)}>ストア管理</Link>}
        </nav>
        <div className="site-header__actions">
          <form className={'header-search ' + (searchOpen ? 'header-search--open' : '')} role="search" onSubmit={submit}>
            <button type="button" aria-label={searchOpen ? '検索欄を閉じる' : '検索欄を開く'} onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) window.setTimeout(() => searchInput.current?.focus(), 0) }}><Search size={18} strokeWidth={1.7} /></button>
            <input ref={searchInput} aria-label="商品を検索" placeholder="商品を探す" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} />
          </form>
          <Link to={user ? '/profile' : '/login'} className="icon-button" aria-label={user ? 'マイページ' : 'ログイン'}><UserRound size={21} strokeWidth={1.6} /></Link>
          <Link to="/cart" className="icon-button cart-icon" aria-label={'カート、' + cartCount + '点'}><ShoppingBag size={21} strokeWidth={1.6} />{cartCount > 0 && <span>{cartCount}</span>}</Link>
        </div>
      </div>
    </header>
  </>
}

function Home({ products, onAdd }: { products: Product[]; onAdd: (id: number) => void }) {
  const featured = products.filter((product) => product.featured).slice(0, 4)
  const displayed = featured.length ? featured : products.slice(0, 4)
  return <main>
    <section className="hero shell">
      <div className="hero__copy">
        <p className="eyebrow"><span className="eyebrow-line" /> Object & Everyday</p>
        <h1>暮らしに、<br /><em>余白</em>を。</h1>
        <p className="hero__lead">置くだけで、いつもの時間が少し心地よくなる。<br />長く使いたくなる道具を、あなたの毎日に。</p>
        <Link to="/shop" className="button button--dark">コレクションを見る <ArrowRight size={18} /></Link>
        <div className="hero__index"><span>01 / 06</span><span className="hero__line" /> CURATED OBJECTS</div>
      </div>
      <div className="hero__visual" aria-label="KOVAの暮らしのイメージ">
        <div className="hero__picture">
          <img src="/images/hero.png" alt="明るい部屋のデスクに置かれたインテリア雑貨" onError={(event) => { event.currentTarget.style.display = 'none' }} />
          <div className="hero__fallback"><div className="hero__sun" /><div className="hero__table" /><div className="hero__lamp"><i /><b /><span /></div><div className="hero__mug" /></div>
        </div>
        <div className="hero__side-label">DESIGNED FOR THE EVERYDAY MOMENTS</div>
        <div className="hero__caption"><span className="hero__caption-dot" /> Curated essentials for your space</div>
      </div>
    </section>

    <section className="value-strip" aria-label="KOVAについて">
      <div className="shell value-strip__inner">
        <div><Sparkles size={22} strokeWidth={1.5} /><span><strong>暮らしに馴染むデザイン</strong><small>毎日使いたくなる、静かな存在感</small></span></div>
        <div><Package size={22} strokeWidth={1.5} /><span><strong>丁寧なものづくり</strong><small>素材と仕上がりにこだわって</small></span></div>
        <div><Truck size={22} strokeWidth={1.5} /><span><strong>心地よいお届け</strong><small>大切な時間を、あなたのもとへ</small></span></div>
      </div>
    </section>

    <section className="section shell featured-section">
      <SectionHeading eyebrow="THE SELECTION" title="今月のおすすめ" description="部屋の空気まで変えてくれる、KOVAの定番アイテム。" action={<Link to="/shop" className="text-link">すべて見る <ArrowRight size={17} /></Link>} />
      <div className="product-grid">{displayed.map((product) => <ProductCard key={product.id} product={product} onAdd={onAdd} />)}</div>
    </section>

    <section className="editorial shell">
      <div className="editorial__visual"><div className="editorial__arch" /><div className="editorial__figure">K<span>O</span>VA</div><span>LESS, BUT BETTER.</span></div>
      <div className="editorial__copy"><p className="eyebrow">OUR PHILOSOPHY</p><h2>いいものと、<br />いい時間を。</h2><p>家具を変えなくても、暮らしは変えられる。手に取るたびに少しうれしくなるものを選びました。飾らず、使い続けられるものを。</p><Link to="/shop" className="button button--outline">アイテムを探す <ArrowRight size={17} /></Link></div>
    </section>

    <section className="section shell category-section">
      <SectionHeading eyebrow="EXPLORE" title="空間から選ぶ" />
      <div className="category-grid">
        <Link to="/shop?category=デスク" className="category-tile category-tile--desk"><span>01 — WORKSPACE</span><strong>デスクを整える</strong><ArrowRight size={20} /></Link>
        <Link to="/shop?category=照明" className="category-tile category-tile--living"><span>02 — LIGHTING</span><strong>明かりを選ぶ</strong><ArrowRight size={20} /></Link>
        <Link to="/shop?category=キッチン" className="category-tile category-tile--life"><span>03 — KITCHEN</span><strong>食卓を楽しむ</strong><ArrowRight size={20} /></Link>
      </div>
    </section>
  </main>
}

function Shop({ products, categories, loading, query, category, onAdd }: { products: Product[]; categories: string[]; loading: boolean; query: string; category: string; onAdd: (id: number) => void }) {
  return <main className="page-shell shell">
    <div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} />すべての商品</div>
    <div className="shop-heading"><div><p className="eyebrow">THE COLLECTION</p><h1>{query ? '「' + query + '」の検索結果' : category ? category : 'すべての商品'}</h1><p>暮らしを心地よくする、こだわりのアイテム。</p></div><span>{products.length} ITEMS</span></div>
    <div className="shop-toolbar"><div className="filter-label"><SlidersHorizontal size={18} /><span>カテゴリー</span></div><div className="category-pills"><Link to={'/shop' + (query ? '?q=' + encodeURIComponent(query) : '')} className={!category ? 'active' : ''}>すべて</Link>{categories.map((item) => <Link key={item} to={'/shop?category=' + encodeURIComponent(item) + (query ? '&q=' + encodeURIComponent(query) : '')} className={category === item ? 'active' : ''}>{item}</Link>)}</div></div>
    {loading ? <div className="page-loading"><Spinner /></div> : products.length ? <div className="product-grid shop-grid">{products.map((product) => <ProductCard key={product.id} product={product} onAdd={onAdd} />)}</div> : <EmptyState icon={<Search size={30} />} title="商品が見つかりませんでした" text="別のキーワードやカテゴリーでお試しください。" action={<Link to="/shop" className="button button--dark">すべての商品を見る</Link>} />}
  </main>
}

function Rating({ value, size = 15 }: { value: number; size?: number }) {
  return <span className="rating" aria-label={'5点中' + value + '点'}>{Array.from({ length: 5 }, (_, index) => <Star key={index} size={size} strokeWidth={1.5} fill={index < value ? 'currentColor' : 'none'} />)}</span>
}

function ProductPage({ id, onAdd, user, notify }: { id: number; onAdd: (id: number, quantity?: number) => Promise<void>; user: User | null; notify: (message: string) => void }) {
  const [product, setProduct] = useState<Product | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [quantity, setQuantity] = useState(1)
  const [loading, setLoading] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [rating, setRating] = useState(5)
  const [reviewTitle, setReviewTitle] = useState('')
  const [reviewBody, setReviewBody] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await client.request<{ product: Product; reviews: Review[] }>('/api/products/' + id)
      setProduct(result.product)
      setReviews(result.reviews)
    } catch (caught) { setError(messageOf(caught)) }
    finally { setLoading(false) }
  }, [id])
  useEffect(() => { load() }, [load])

  const submitReview = async (event: FormEvent) => {
    event.preventDefault()
    if (!user) { go('/login?next=' + encodeURIComponent('/product/' + id)); return }
    setReviewBusy(true)
    setError('')
    try {
      await client.request('/api/products/' + id + '/reviews', 'POST', { rating, title: reviewTitle, body: reviewBody })
      setReviewTitle('')
      setReviewBody('')
      setRating(5)
      setReviewOpen(false)
      await load()
      notify('レビューを投稿しました')
    } catch (caught) { setError(messageOf(caught)) }
    finally { setReviewBusy(false) }
  }

  if (loading) return <main className="page-shell shell page-loading"><Spinner /></main>
  if (!product) return <main className="page-shell shell"><EmptyState icon={<Package size={30} />} title="商品が見つかりませんでした" text={error || '商品一覧からお探しください。'} action={<Link to="/shop" className="button button--dark">商品一覧に戻る</Link>} /></main>
  const average = reviews.length ? Math.round((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10) / 10 : 0
  return <main className="page-shell shell">
    <div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} /><Link to="/shop">商品一覧</Link><ChevronRight size={14} />{product.name}</div>
    <section className="product-detail">
      <ProductVisual product={product} className="product-detail__visual" />
      <div className="product-detail__info">
        <p className="eyebrow">{product.category} / KOVA OBJECTS</p>
        <h1>{product.name}</h1>
        <div className="product-detail__rating"><Rating value={Math.round(average)} /><button type="button" onClick={() => document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth' })}>{reviews.length ? average + ' / 5.0 · ' + reviews.length + '件のレビュー' : 'レビューを書く'}</button></div>
        <p className="product-detail__price">{money(product.price)} <small>税込</small></p>
        <div className="product-detail__divider" />
        <p className="product-detail__description">{product.description}</p>
        <div className="product-detail__availability"><span className={product.stock > 0 ? 'status-dot' : 'status-dot status-dot--off'} />{product.stock > 0 ? '在庫あり · すぐにお届け' : '在庫切れ'}</div>
        <div className="product-detail__purchase"><div className="stepper"><button type="button" aria-label="数量を減らす" onClick={() => setQuantity(Math.max(1, quantity - 1))}><Minus size={16} /></button><span>{quantity}</span><button type="button" aria-label="数量を増やす" onClick={() => setQuantity(Math.min(product.stock, quantity + 1))}><Plus size={16} /></button></div><button type="button" className="button button--dark" disabled={product.stock <= 0} onClick={() => onAdd(product.id, quantity)}><ShoppingBag size={18} /> カートに入れる <ArrowRight size={17} /></button></div>
        <div className="product-detail__benefits"><div><Truck size={20} strokeWidth={1.5} /><span>通常配送・お急ぎ便から選べます</span></div><div><Package size={20} strokeWidth={1.5} /><span>大切に梱包してお届けします</span></div></div>
      </div>
    </section>
    <section className="reviews-section" id="reviews">
      <div className="reviews-section__heading"><div><p className="eyebrow">YOUR STORIES</p><h2>お客さまの声</h2><div className="reviews-overview"><strong>{reviews.length ? average.toFixed(1) : '—'}</strong><span><Rating value={Math.round(average)} /><small>{reviews.length}件のレビュー</small></span></div></div><button type="button" className="button button--outline" onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? '閉じる' : 'レビューを書く'} <ArrowRight size={17} /></button></div>
      {reviewOpen && <form className="review-form" onSubmit={submitReview}><h3>この商品をレビューする</h3><label>評価</label><div className="rating-input" role="group" aria-label="評価">{[1, 2, 3, 4, 5].map((score) => <button key={score} type="button" aria-label={score + '点'} onClick={() => setRating(score)}><Star size={24} fill={score <= rating ? 'currentColor' : 'none'} /></button>)}</div><label htmlFor="review-title">タイトル</label><input id="review-title" required maxLength={80} value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} placeholder="ひとことで感想を" /><label htmlFor="review-body">レビュー</label><textarea id="review-body" required rows={5} maxLength={1000} value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="使ってみた感想をお聞かせください" />{error && <p className="form-error" role="alert">{error}</p>}<button className="button button--dark" type="submit" disabled={reviewBusy}>{reviewBusy ? '投稿中...' : 'レビューを投稿する'}</button></form>}
      {reviews.length ? <div className="review-list">{reviews.map((review) => <article className="review" key={review.id}><div className="review__meta"><div className="avatar">{review.authorName.slice(0, 1)}</div><div><strong>{review.authorName}</strong><small>{date(review.createdAt)}</small></div></div><div className="review__body"><Rating value={review.rating} /><h3>{review.title}</h3><div className="review__content" dangerouslySetInnerHTML={{ __html: review.body }} /></div></article>)}</div> : <p className="reviews-empty">まだレビューはありません。最初の感想をお寄せください。</p>}
    </section>
  </main>
}

function CartPage({ cart, user, busy, onUpdate, onRemove }: { cart: Cart; user: User | null; busy: boolean; onUpdate: (id: number, quantity: number) => void; onRemove: (id: number) => void }) {
  return <main className="page-shell shell narrow-page">
    <div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} />カート</div>
    <div className="page-title"><p className="eyebrow">YOUR BAG</p><h1>ショッピングバッグ <span>({cart.items.reduce((sum, item) => sum + item.quantity, 0)})</span></h1></div>
    {!user ? <EmptyState icon={<ShoppingBag size={34} />} title="ログインしてお買い物を続ける" text="カートを利用するにはログインしてください。" action={<Link to="/login?next=%2Fcart" className="button button--dark">ログインへ <ArrowRight size={17} /></Link>} /> : cart.items.length ? <div className="split-layout">
      <div className="cart-list">{cart.items.map((item) => <article className="cart-item" key={item.id}><Link to={'/product/' + item.product.id} className="cart-item__image"><ProductVisual product={item.product} /></Link><div className="cart-item__info"><span>{item.product.category}</span><Link to={'/product/' + item.product.id}>{item.product.name}</Link><strong>{money(item.product.price)}</strong><div className="cart-item__controls"><div className="stepper stepper--small"><button type="button" aria-label={item.product.name + 'の数量を減らす'} disabled={busy} onClick={() => onUpdate(item.id, item.quantity - 1)}><Minus size={14} /></button><span>{item.quantity}</span><button type="button" aria-label={item.product.name + 'の数量を増やす'} disabled={busy} onClick={() => onUpdate(item.id, item.quantity + 1)}><Plus size={14} /></button></div><button className="remove-button" type="button" disabled={busy} onClick={() => onRemove(item.id)}><Trash2 size={16} /> 削除</button></div></div><strong className="cart-item__total">{money(item.product.price * item.quantity)}</strong></article>)}</div>
      <aside className="order-summary"><h2>ご注文内容</h2><div><span>小計</span><strong>{money(cart.subtotal)}</strong></div><div><span>送料</span><span>お届け先入力後に計算</span></div><div className="order-summary__total"><span>小計</span><strong>{money(cart.subtotal)}</strong></div><Link to="/checkout" className="button button--dark">ご購入手続きへ <ArrowRight size={17} /></Link><Link to="/shop" className="order-summary__continue"><ArrowLeft size={16} /> お買い物を続ける</Link></aside>
    </div> : <EmptyState icon={<ShoppingBag size={34} />} title="カートは空です" text="お気に入りのアイテムを見つけてみませんか。" action={<Link to="/shop" className="button button--dark">商品を探す <ArrowRight size={17} /></Link>} />}
  </main>
}

function CheckoutPage({ cart, user, notify, refreshCart }: { cart: Cart; user: User | null; notify: (message: string) => void; refreshCart: () => Promise<void> }) {
  const [name, setName] = useState(user?.name || '')
  const [address, setAddress] = useState(user?.address || '')
  const [postalCode, setPostalCode] = useState('')
  const [method, setMethod] = useState('standard')
  const [shippingFee, setShippingFee] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!user || !postalCode.trim()) { setShippingFee(null); return }
    let active = true
    setShippingFee(null)
    const timer = window.setTimeout(() => {
      client.request<{ method: string; fee: number }>('/api/shipping/quote', 'POST', { method, postalCode }).then((result) => { if (active) setShippingFee(result.fee) }).catch(() => { if (active) setShippingFee(null) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [method, postalCode, user])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!user) { go('/login?next=%2Fcheckout'); return }
    if (!cart.items.length) return
    setBusy(true)
    setError('')
    try {
      const result = await client.request<{ order: Order }>('/api/checkout', 'POST', { name, address, postalCode, method, shippingFee: shippingFee || 0 })
      await refreshCart()
      notify('ご注文ありがとうございます')
      go('/orders/' + result.order.id)
    } catch (caught) { setError(messageOf(caught)) }
    finally { setBusy(false) }
  }
  if (!user) return <main className="page-shell shell"><EmptyState icon={<LockKeyhole size={32} />} title="ログインして購入手続きを続ける" text="お届け先の確認とご注文にはログインが必要です。" action={<Link to="/login?next=%2Fcheckout" className="button button--dark">ログインへ <ArrowRight size={17} /></Link>} /></main>
  if (!cart.items.length) return <main className="page-shell shell"><EmptyState icon={<ShoppingBag size={34} />} title="カートに商品がありません" text="商品を追加してから購入手続きに進んでください。" action={<Link to="/shop" className="button button--dark">商品を探す</Link>} /></main>
  return <main className="page-shell shell narrow-page">
    <div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} /><Link to="/cart">カート</Link><ChevronRight size={14} />ご購入手続き</div>
    <div className="page-title"><p className="eyebrow">CHECKOUT</p><h1>ご購入手続き</h1></div>
    <form className="split-layout" onSubmit={submit}>
      <div className="checkout-form">
        <section className="form-panel"><div className="form-panel__heading"><span>01</span><h2>お届け先</h2></div><div className="form-grid"><label className="field"><span>お名前</span><input required maxLength={80} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="山田 太郎" /></label><label className="field"><span>郵便番号</span><input required maxLength={12} autoComplete="postal-code" value={postalCode} onChange={(event) => setPostalCode(event.target.value)} placeholder="100-0001" /></label><label className="field field--full"><span>ご住所</span><input required maxLength={200} autoComplete="street-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="東京都千代田区千代田 1-1" /></label></div></section>
        <section className="form-panel"><div className="form-panel__heading"><span>02</span><h2>配送方法</h2></div><div className="shipping-options"><label className={method === 'standard' ? 'shipping-option active' : 'shipping-option'}><input type="radio" name="method" value="standard" checked={method === 'standard'} onChange={() => setMethod('standard')} /><span><strong>通常配送</strong><small>3〜5営業日でお届け</small></span><b>{method === 'standard' && shippingFee !== null ? money(shippingFee) : '—'}</b></label><label className={method === 'express' ? 'shipping-option active' : 'shipping-option'}><input type="radio" name="method" value="express" checked={method === 'express'} onChange={() => setMethod('express')} /><span><strong>お急ぎ便</strong><small>1〜2営業日でお届け</small></span><b>{method === 'express' && shippingFee !== null ? money(shippingFee) : '—'}</b></label></div></section>
        <div className="checkout-note"><LockKeyhole size={17} /><span>このストアでは代金引換のみご利用いただけます。</span></div>
      </div>
      <aside className="order-summary order-summary--checkout"><h2>ご注文内容</h2><div className="checkout-items">{cart.items.map((item) => <div key={item.id}><span>{item.product.name} <small>× {item.quantity}</small></span><strong>{money(item.product.price * item.quantity)}</strong></div>)}</div><div><span>小計</span><strong>{money(cart.subtotal)}</strong></div><div><span>送料</span><strong>{shippingFee === null ? '—' : money(shippingFee)}</strong></div><div className="order-summary__total"><span>合計</span><strong>{money(cart.subtotal + (shippingFee || 0))}</strong></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button--dark" type="submit" disabled={busy || shippingFee === null}>{busy ? 'ご注文を処理しています...' : '注文を確定する'} <ArrowRight size={17} /></button><p className="order-summary__note">ボタンを押すと、ご注文が確定します。</p></aside>
    </form>
  </main>
}

function AuthPage({ mode, onSuccess, notify }: { mode: 'login' | 'register'; onSuccess: (next: string) => Promise<void>; notify: (message: string) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const route = useRoute()
  const next = route.query.get('next') || '/profile'
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await client.request('/api/auth/' + mode, 'POST', mode === 'register' ? { name, email, password } : { email, password })
      await onSuccess(next.startsWith('/') ? next : '/profile')
      notify(mode === 'register' ? 'アカウントを作成しました' : 'おかえりなさい')
    } catch (caught) { setError(messageOf(caught)) }
    finally { setBusy(false) }
  }
  return <main className="auth-page"><div className="auth-page__visual"><Link to="/" className="wordmark">KOVA<span>.</span></Link><div className="auth-page__scene"><div className="auth-page__circle" /><div className="auth-page__vase" /><div className="auth-page__stem" /><div className="auth-page__stem auth-page__stem--two" /></div><div className="auth-page__quote">Make space<br />for better<br /><em>moments.</em></div><small>OBJECTS FOR YOUR EVERYDAY</small></div><div className="auth-page__form-wrap"><Link to="/" className="auth-page__back"><ArrowLeft size={17} /> ストアに戻る</Link><div className="auth-card"><p className="eyebrow">WELCOME TO KOVA</p><h1>{mode === 'register' ? 'アカウントを作成' : 'おかえりなさい'}</h1><p>{mode === 'register' ? 'KOVAと、心地よい毎日をはじめましょう。' : 'ログインして、お買い物を続けましょう。'}</p><form onSubmit={submit}>{mode === 'register' && <label className="field"><span>お名前</span><input required maxLength={80} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="山田 太郎" /></label>}<label className="field"><span>メールアドレス</span><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><label className="field"><span>パスワード</span><input required type="password" minLength={mode === 'register' ? 10 : undefined} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'register' ? '10文字以上' : 'パスワード'} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button--dark" type="submit" disabled={busy}>{busy ? '処理中...' : mode === 'register' ? 'アカウントを作成' : 'ログイン'} <ArrowRight size={17} /></button></form><div className="auth-card__switch">{mode === 'register' ? 'すでにアカウントをお持ちですか？' : 'はじめてご利用ですか？'} <Link to={mode === 'register' ? '/login' : '/register'}>{mode === 'register' ? 'ログイン' : '新規登録'}</Link></div></div></div></main>
}

function OrdersPage({ notify }: { notify: (message: string) => void }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { client.request<{ orders: Order[] }>('/api/orders').then((result) => setOrders(result.orders)).catch((error) => notify(messageOf(error))).finally(() => setLoading(false)) }, [notify])
  return <main className="page-shell shell narrow-page"><div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} /><Link to="/profile">マイページ</Link><ChevronRight size={14} />注文履歴</div><div className="page-title"><p className="eyebrow">ORDER HISTORY</p><h1>注文履歴</h1></div>{loading ? <div className="page-loading"><Spinner /></div> : orders.length ? <div className="order-list">{orders.map((order) => <Link to={'/orders/' + order.id} className="order-row" key={order.id}><div className="order-row__icon"><Package size={23} strokeWidth={1.4} /></div><div><span>注文番号 #{order.id} · {date(order.createdAt)}</span><strong>{order.items.map((item) => item.name).join('、')}</strong><small>{statusText(order.status)} · {order.items.reduce((sum, item) => sum + item.quantity, 0)}点</small></div><strong>{money(order.total)}</strong><ChevronRight size={18} /></Link>)}</div> : <EmptyState icon={<Package size={32} />} title="まだご注文はありません" text="気になるアイテムから、お買い物をはじめましょう。" action={<Link to="/shop" className="button button--dark">商品を探す</Link>} />}</main>
}

function OrderDetail({ id, notify }: { id: string; notify: (message: string) => void }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => { setLoading(true); client.request<{ order: Order }>('/api/orders/' + id).then((result) => setOrder(result.order)).catch((error) => notify(messageOf(error))).finally(() => setLoading(false)) }, [id, notify])
  return <main className="page-shell shell narrow-page"><div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} /><Link to="/orders">注文履歴</Link><ChevronRight size={14} />注文番号 #{id}</div>{loading ? <div className="page-loading"><Spinner /></div> : order ? <><div className="order-confirmation"><div className="order-confirmation__icon"><Check size={30} /></div><p className="eyebrow">ORDER DETAILS</p><h1>ご注文の詳細</h1><p>ご注文内容と配送状況をご確認いただけます。</p></div><div className="order-detail-grid"><section className="form-panel"><h2>ご注文情報</h2><div className="detail-pair"><span>注文番号</span><strong>#{order.id}</strong></div><div className="detail-pair"><span>注文日</span><strong>{date(order.createdAt)}</strong></div><div className="detail-pair"><span>ステータス</span><strong className="status-badge">{statusText(order.status)}</strong></div><div className="detail-pair"><span>配送方法</span><strong>{order.method === 'express' ? 'お急ぎ便' : '通常配送'}</strong></div></section><section className="form-panel"><h2>お届け先</h2><p className="address-copy">{order.name}<br />〒{order.postalCode}<br />{order.address}</p></section></div><section className="form-panel order-detail-items"><h2>ご注文商品</h2>{order.items.map((item, index) => <div className="detail-pair" key={index}><span>{item.name} × {item.quantity}</span><strong>{money(item.price * item.quantity)}</strong></div>)}<div className="detail-pair"><span>小計</span><strong>{money(order.subtotal)}</strong></div><div className="detail-pair"><span>送料</span><strong>{money(order.shippingFee)}</strong></div><div className="detail-pair detail-pair--total"><span>合計</span><strong>{money(order.total)}</strong></div></section><Link to="/shop" className="button button--outline order-detail-back">お買い物を続ける <ArrowRight size={17} /></Link></> : <EmptyState icon={<Package size={30} />} title="注文が見つかりませんでした" text="注文履歴からお確かめください。" action={<Link to="/orders" className="button button--dark">注文履歴へ</Link>} />}</main>
}

function ProfilePage({ user, onLogout, notify, onUpdated }: { user: User; onLogout: () => void; notify: (message: string) => void; onUpdated: () => Promise<unknown> }) {
  const [name, setName] = useState(user.name)
  const [address, setAddress] = useState(user.address || '')
  const [bio, setBio] = useState(user.bio || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { client.request<{ profile: User }>('/api/profile').then((result) => { setName(result.profile.name); setAddress(result.profile.address || ''); setBio(result.profile.bio || '') }).catch(() => {}) }, [])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await client.request('/api/profile', 'PATCH', { name, address, bio })
      await onUpdated()
      notify('プロフィールを更新しました')
    } catch (caught) { setError(messageOf(caught)) }
    finally { setBusy(false) }
  }
  return <main className="page-shell shell narrow-page"><div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} />マイページ</div><div className="page-title"><p className="eyebrow">MY ACCOUNT</p><h1>マイページ</h1></div><div className="profile-layout"><aside className="profile-menu"><div className="profile-menu__user"><div className="avatar avatar--large">{user.name.slice(0, 1)}</div><strong>{user.name}</strong><small>{user.email}</small></div><Link to="/profile" className="active"><UserRound size={18} /> プロフィール</Link><Link to="/orders"><Package size={18} /> 注文履歴</Link>{user.role === 'staff' && <Link to="/staff"><SlidersHorizontal size={18} /> ストア管理</Link>}<button type="button" onClick={onLogout}>ログアウト <ArrowRight size={17} /></button></aside><div className="profile-content"><form className="form-panel" onSubmit={save}><div className="form-panel__heading"><span>01</span><h2>基本情報</h2></div><label className="field"><span>お名前</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>メールアドレス</span><input value={user.email} disabled /></label><label className="field"><span>ご住所</span><input maxLength={200} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="お届け先として利用できます" /></label><label className="field"><span>自己紹介</span><textarea rows={4} maxLength={300} value={bio} onChange={(event) => setBio(event.target.value)} placeholder="あなたについて少し教えてください" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button--dark" type="submit" disabled={busy}>{busy ? '保存中...' : '変更を保存'} <ArrowRight size={17} /></button></form></div></div></main>
}

function StaffPage({ notify }: { notify: (message: string) => void }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [stats, setStats] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const result = await client.request<{ stats: Record<string, number>; orders: Order[] }>('/api/staff/overview')
    setStats(result.stats)
    setOrders(result.orders)
  }, [])
  useEffect(() => { reload().catch((error) => notify(messageOf(error))).finally(() => setLoading(false)) }, [reload, notify])
  const update = async (id: string, status: string) => {
    setBusy(id)
    try { await client.request('/api/staff/orders/' + id, 'PATCH', { status }); await reload(); notify('注文ステータスを更新しました') }
    catch (caught) { notify(messageOf(caught)) }
    finally { setBusy(null) }
  }
  return <main className="page-shell shell"><div className="breadcrumbs"><Link to="/">ホーム</Link><ChevronRight size={14} />ストア管理</div><div className="page-title"><p className="eyebrow">STORE OPERATIONS</p><h1>ストア管理</h1><p>注文の状況を確認・更新できます。</p></div>{loading ? <div className="page-loading"><Spinner /></div> : <><div className="staff-stats"><div><span>注文件数</span><strong>{stats.orders ?? orders.length}</strong><small>すべての注文</small></div><div><span>売上合計</span><strong>{money(stats.revenue ?? 0)}</strong><small>累計売上</small></div><div><span>発送待ち</span><strong>{stats.processing ?? orders.filter((order) => order.status === 'processing').length}</strong><small>対応が必要な注文</small></div></div><div className="staff-table"><div className="staff-table__head"><span>注文</span><span>お客様</span><span>合計</span><span>ステータス</span></div>{orders.map((order) => <div className="staff-table__row" key={order.id}><div><strong>#{order.id}</strong><small>{date(order.createdAt)}</small></div><div>{order.name}</div><div>{money(order.total)}</div><div><label className="select-wrap"><span className="sr-only">注文 #{order.id} のステータス</span><select value={order.status} disabled={busy === order.id} onChange={(event) => update(order.id, event.target.value)}><option value="processing">処理中</option><option value="shipped">発送済み</option><option value="delivered">配達済み</option><option value="cancelled">キャンセル</option></select><ChevronDown size={15} /></label></div></div>)}</div>{!orders.length && <EmptyState icon={<Package size={30} />} title="注文はありません" text="新しい注文が入るとここに表示されます。" />}</>}</main>
}

function Footer() {
  return <footer className="site-footer"><div className="shell"><div className="site-footer__top"><div><Link to="/" className="wordmark">KOVA<span>.</span></Link><p>小さな変化で、暮らしはもっと心地よく。<br />毎日に寄り添う道具をお届けします。</p></div><div><span>EXPLORE</span><Link to="/shop">すべての商品</Link><Link to="/shop?category=デスク">デスク</Link><Link to="/shop?category=照明">照明</Link></div><div><span>ACCOUNT</span><Link to="/profile">マイページ</Link><Link to="/orders">注文履歴</Link><Link to="/cart">ショッピングバッグ</Link></div><div className="site-footer__letter"><span>THE KOVA EDIT</span><strong>日常の、いいもの。</strong><p>自分らしい空間づくりのヒントを、商品から見つけてください。</p><Link to="/shop" className="text-link">商品を見る <ArrowRight size={17} /></Link></div></div><div className="site-footer__bottom"><span>© 2026 KOVA. All rights reserved.</span><span>Made for the moments that matter.</span><Instagram size={17} strokeWidth={1.5} /></div></div></footer>
}

function statusText(status: string) {
  return ({ processing: '処理中', shipped: '発送済み', delivered: '配達済み', cancelled: 'キャンセル' } as Record<string, string>)[status] || status
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '処理に失敗しました'
}

export default function App() {
  const route = useRoute()
  const [session, setSession] = useState<Session | undefined>()
  const [products, setProducts] = useState<Product[]>([])
  const [shopProducts, setShopProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [shopLoading, setShopLoading] = useState(false)
  const [cart, setCart] = useState<Cart>(emptyCart)
  const [cartBusy, setCartBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [initialError, setInitialError] = useState('')
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(''), 4500) }, [])
  const refreshSession = useCallback(async () => {
    const data = await client.request<Session>('/api/session')
    client.csrf = data.csrfToken
    setSession(data)
    return data
  }, [])
  const refreshCart = useCallback(async () => {
    try { const data = await client.request<Cart>('/api/cart'); setCart(data) }
    catch (error) { if (error instanceof HttpError && error.status === 401) setCart(emptyCart); else throw error }
  }, [])
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        await refreshSession()
        const [catalog] = await Promise.all([
          client.request<{ products: Product[]; categories: string[] }>('/api/products'),
          refreshCart(),
        ])
        if (active) { setProducts(catalog.products); setCategories(catalog.categories) }
      } catch (error) { if (active) setInitialError(messageOf(error)) }
    })()
    return () => { active = false }
  }, [refreshSession, refreshCart])

  const query = route.query.get('q') || ''
  const category = route.query.get('category') || ''
  useEffect(() => {
    if (route.path !== '/shop') return
    let active = true
    setShopLoading(true)
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (category) params.set('category', category)
    client.request<{ products: Product[]; categories: string[] }>('/api/products' + (params.size ? '?' + params : '')).then((result) => {
      if (active) { setShopProducts(result.products); setCategories(result.categories) }
    }).catch((error) => { if (active) { setShopProducts([]); notify(messageOf(error)) } }).finally(() => { if (active) setShopLoading(false) })
    return () => { active = false }
  }, [route.path, query, category, notify])

  useEffect(() => { if (route.path === '/cart' || route.path === '/checkout') refreshCart().catch((error) => notify(messageOf(error))) }, [route.path, refreshCart, notify])

  const addToCart = useCallback(async (id: number, quantity = 1) => {
    setCartBusy(true)
    try { const updated = await client.request<Cart>('/api/cart', 'POST', { productId: id, quantity }); setCart(updated); notify('カートに追加しました') }
    catch (error) { if (error instanceof HttpError && error.status === 401) go('/login?next=' + encodeURIComponent(route.path)); else notify(messageOf(error)) }
    finally { setCartBusy(false) }
  }, [notify, route.path])
  const updateCart = async (id: number, quantity: number) => {
    if (quantity < 1) { await removeCart(id); return }
    setCartBusy(true)
    try { const updated = await client.request<Cart>('/api/cart/' + id, 'PATCH', { quantity }); setCart(updated) }
    catch (error) { notify(messageOf(error)) }
    finally { setCartBusy(false) }
  }
  const removeCart = async (id: number) => {
    setCartBusy(true)
    try { const updated = await client.request<Cart>('/api/cart/' + id, 'DELETE'); setCart(updated); notify('カートから削除しました') }
    catch (error) { notify(messageOf(error)) }
    finally { setCartBusy(false) }
  }
  const logout = async () => {
    try { await client.request('/api/auth/logout', 'POST'); await refreshSession(); setCart(emptyCart); go('/'); notify('ログアウトしました') }
    catch (error) { notify(messageOf(error)) }
  }
  const authSuccess = async (next: string) => { await refreshSession(); await refreshCart(); go(next) }
  const user = session?.user || null
  const cartCount = cart.items.reduce((sum, item) => sum + item.quantity, 0)
  const orderMatch = route.path.match(/^\/orders\/([^/]+)$/)
  const productMatch = route.path.match(/^\/product\/(\d+)$/)
  const page = (() => {
    if (route.path === '/') return <Home products={products} onAdd={addToCart} />
    if (route.path === '/shop') return <Shop products={shopProducts} categories={categories} loading={shopLoading} query={query} category={category} onAdd={addToCart} />
    if (productMatch) return <ProductPage key={productMatch[1]} id={Number(productMatch[1])} onAdd={addToCart} user={user} notify={notify} />
    if (route.path === '/cart') return <CartPage cart={cart} user={user} busy={cartBusy} onUpdate={updateCart} onRemove={removeCart} />
    if (route.path === '/checkout') return <CheckoutPage cart={cart} user={user} notify={notify} refreshCart={refreshCart} />
    if (route.path === '/login' || route.path === '/register') return <AuthPage key={route.path} mode={route.path === '/login' ? 'login' : 'register'} onSuccess={authSuccess} notify={notify} />
    if (route.path === '/profile') return user ? <ProfilePage user={user} onLogout={logout} notify={notify} onUpdated={refreshSession} /> : <AuthPrompt />
    if (route.path === '/orders') return user ? <OrdersPage notify={notify} /> : <AuthPrompt />
    if (orderMatch) return user ? <OrderDetail key={orderMatch[1]} id={orderMatch[1]} notify={notify} /> : <AuthPrompt />
    if (route.path === '/staff') return user?.role === 'staff' ? <StaffPage notify={notify} /> : <EmptyState icon={<LockKeyhole size={30} />} title="ページを表示できません" text="このページへのアクセス権がありません。" action={<Link to="/" className="button button--dark">トップへ戻る</Link>} />
    return <main className="page-shell shell"><EmptyState icon={<Search size={30} />} title="ページが見つかりませんでした" text="お探しのページは移動したか、存在しません。" action={<Link to="/" className="button button--dark">トップへ戻る</Link>} /></main>
  })()

  if (!session && !initialError) return <div className="boot-screen"><span className="wordmark">KOVA<span>.</span></span><Spinner /></div>
  if (initialError) return <div className="boot-screen"><span className="wordmark">KOVA<span>.</span></span><p>{initialError}</p><button type="button" className="button button--dark" onClick={() => window.location.reload()}>再読み込み</button></div>
  const authPage = route.path === '/login' || route.path === '/register'
  return <div className="app">
    {!authPage && <Header user={user} cartCount={cartCount} />}
    {page}
    {!authPage && <Footer />}
    {toast && <div className="toast" role="status"><Check size={18} />{toast}<button type="button" onClick={() => setToast('')} aria-label="通知を閉じる"><X size={16} /></button></div>}
  </div>
}

function AuthPrompt() {
  return <main className="page-shell shell"><EmptyState icon={<LockKeyhole size={30} />} title="ログインが必要です" text="ログインすると、注文履歴やプロフィールを確認できます。" action={<Link to="/login" className="button button--dark">ログインへ <ArrowRight size={17} /></Link>} /></main>
}
