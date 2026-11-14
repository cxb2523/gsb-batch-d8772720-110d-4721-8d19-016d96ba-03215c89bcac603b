# 4 · Crawling con paginación

Recorre múltiples páginas siguiendo el enlace "siguiente" y junta todos los registros.

```python
items = bot.crawl(
    "https://quotes.toscrape.com",
    item="div.quote",
    fields={"quote": "span.text::text", "tags[]": "a.tag::text"},
    next_page="li.next a::attr(href)",
)
```

## Saber cómo terminó cada página (`detailed=True`)

La lista plana no distingue un sitio agotado de un recorrido cortado, y si una
petición falla a mitad del recorrido se pierde lo ya extraído. Con
`detailed=True` el resultado pasa a ser un dict con una entrada por página
intentada y el total de registros reunidos:

```python
from bytecrawl import (
    CRAWL_SUCCESS,
    CRAWL_REQUEST_FAILED,
    CRAWL_NO_NEXT_PAGE,
    CRAWL_PAGES_LIMIT,
)

report = bot.crawl(
    "https://quotes.toscrape.com",
    item="div.quote",
    fields={"quote": "span.text::text"},
    next_page="li.next a::attr(href)",
    detailed=True,
)
# {
#   "pages": [
#     {"page": 1, "url": "...", "count": 10, "outcome": "success", "error": None},
#     {"page": 2, "url": "...", "count": 10, "outcome": "no_next_page", "error": None},
#   ],
#   "records": [...todos los registros de las páginas exitosas...],
# }
```

Los cuatro finales posibles:

| Constante | Cuándo |
| --- | --- |
| `CRAWL_SUCCESS` | La página se descargó bien y el recorrido continúa (o siguió) a la siguiente. |
| `CRAWL_REQUEST_FAILED` | La petición falló: la página queda con `count` 0 y `error` con el texto de la excepción. El recorrido se detiene sin inventar la siguiente URL, pero `records` conserva todo lo extraído antes. |
| `CRAWL_NO_NEXT_PAGE` | La página se descargó bien pero ya no hay enlace "siguiente": el final normal. |
| `CRAWL_PAGES_LIMIT` | La página se descargó bien y se alcanzó el tope `pages`: un corte deliberado, distinto del final normal. |

Si la primera página ya falla, `records` viene vacío pero la página fallida
sigue figurando en `pages` con su `outcome` y su `error`. Sin `detailed=True`
el comportamiento es el de siempre: una lista plana y la excepción propagándose
cuando una petición falla.

---

[← Volver al índice](../README.es.md) · [Siguiente: Login con sesión →](05-login-sesion.md)
