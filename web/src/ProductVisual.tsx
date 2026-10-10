import { useState } from 'react'

export type ProductImage = {
  id: number
  slug: string
  name: string
  image: string
  accent?: string
}

const imageNames: Record<string, string> = {
  lamp: 'arc-table-lamp',
  mat: 'terra-desk-mat',
  mug: 'form-ceramic-mug',
  notebook: 'linen-notebook',
  speaker: 'orbit-speaker',
  tray: 'nest-storage-tray',
}

function kindFor(product: ProductImage) {
  const key = product.image || product.slug
  if (key.includes('lamp')) return 'lamp'
  if (key.includes('mat')) return 'mat'
  if (key.includes('mug')) return 'mug'
  if (key.includes('notebook')) return 'notebook'
  if (key.includes('speaker')) return 'speaker'
  if (key.includes('tray')) return 'tray'
  return 'abstract'
}

export default function ProductVisual({ product, className = '' }: { product: ProductImage; className?: string }) {
  const [failed, setFailed] = useState(false)
  const kind = kindFor(product)
  const image = product.image.startsWith('/')
    ? product.image
    : '/images/' + (imageNames[product.image] || product.slug) + '.png'

  return (
    <div className={'product-visual product-visual--' + kind + ' ' + className}>
      {!failed && (
        <img
          src={image}
          alt={product.name}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <div className={'product-illustration product-illustration--' + kind} role="img" aria-label={product.name}>
          <span className="illustration-shadow" />
          <span className="illustration-part illustration-part--one" />
          <span className="illustration-part illustration-part--two" />
          <span className="illustration-part illustration-part--three" />
        </div>
      )}
    </div>
  )
}
