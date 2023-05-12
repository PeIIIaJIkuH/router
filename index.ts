import {action, atom, AtomMut} from '@reatom/core'
import {onConnect} from "@reatom/hooks";

// Splitting string by delimiter
type Split<S extends string, D extends string> = string extends S
  ? string[]
  : S extends ''
    ? []
    : S extends `${infer T}${D}${infer U}`
      ? [T, ...Split<U, D>]
      : [S]

// Converting path array to object
type PathToParams<PathArray, Params = {}> = PathArray extends [
    infer First,
    ...infer Rest
  ]
  ? First extends `:${infer Param}`
    ? // eslint-disable-next-line @typescript-eslint/no-shadow
    First extends `:${infer Param}?`
      ? PathToParams<Rest, Params & Partial<Record<Param, string>>>
      : PathToParams<Rest, Params & Record<Param, string>>
    : PathToParams<Rest, Params>
  : Params

type ParseUrl<Path extends string> = PathToParams<Split<Path, '/'>>

type RouterConfig = Record<string, string | Pattern<any>>

type ParamsFromConfig<K extends RouterConfig> = {
  [key in keyof K]: K[key] extends Pattern<infer P>
    ? P
    : K[key] extends string
      ? ParseUrl<K[key]>
      : never
}

type MappedC<A, B> = {
  [K in keyof A & keyof B]: A[K] extends B[K] ? never : K
}
type OptionalKeys<T> = MappedC<T, Required<T>>[keyof T]

export type ParamsArg<
  Config extends RouterConfig,
  PageName extends keyof Config
> = keyof ParamsFromConfig<Config>[PageName] extends never
  ? []
  : keyof ParamsFromConfig<Config>[PageName] extends OptionalKeys<
      ParamsFromConfig<Config>[PageName]
    >
    ? [ParamsFromConfig<Config>[PageName]?]
    : [ParamsFromConfig<Config>[PageName]]

type Pattern<RouteParams> = Readonly<
  [RegExp, (...parts: string[]) => RouteParams]
>

type Page<
  Config extends RouterConfig = RouterConfig,
  PageName extends keyof Config = any
> = PageName extends any
  ? {
    path: string
    route: PageName
    params: ParamsFromConfig<Config>[PageName]
  }
  : never

interface RouterOptions {
  search?: boolean
  links?: boolean
}

/**
 * Router store. Use {@link createRouter} to create it.
 *
 * It is a simple router without callbacks. Think about it as a URL parser.
 *
 * ```ts
 * import { createRouter } from 'nanostores'
 *
 * export const router = createRouter({
 *   home: '/',
 *   category: '/posts/:categoryId',
 *   post: '/posts/:categoryId/:id'
 * } as const)
 * ```
 */
interface Router<Config extends RouterConfig = RouterConfig>
  extends AtomMut<Page<Config, keyof Config> | undefined> {
  /**
   * Converted routes.
   */
  routes: [string, RegExp, (...params: string[]) => object, string?][]

  /**
   * Open URL without page reloading.
   *
   * ```js
   * router.open('/posts/guides/10')
   * ```
   *
   * @param path Absolute URL (`https://example.com/a`)
   *             or domain-less URL (`/a`).
   * @param redirect Don’t add entry to the navigation history.
   */
  open(path: string, redirect?: boolean): void
}

export function createRouter<const Config extends RouterConfig>(routes: Config, opts: RouterOptions = {}): Router<Config> {
  let router: Router<Config> = Object.assign(atom({}), {
    routes: Object.keys(routes).map(name => {
      let value = routes[name]
      if (typeof value === 'string') {
        value = value.replace(/\/$/g, '') || '/'
        let names = (value.match(/\/:\w+/g) || []).map(i => i.slice(2))
        let pattern = value
          .replace(/[\s!#$()+,.:<=?[\\\]^{|}]/g, '\\$&')
          .replace(/\/\\:\w+\\\?/g, '/?([^/]*)')
          .replace(/\/\\:\w+/g, '/([^/]+)')
        return [
          name,
          RegExp('^' + pattern + '$', 'i'),
          (...matches: string[]) =>
            matches.reduce((params, match, index) => {
              params[names[index]] = decodeURIComponent(match)
              return params
            }, {} as Record<string, string>),
          value
        ]
      } else {
        return [name, ...value]
      }
    }),
    open: action((ctx, path: string, redirect?: boolean) => {
      let page = parse(path)
      if (page !== false) {
        if (typeof history !== 'undefined') {
          if (redirect) {
            history.replaceState(null, '', path)
          } else {
            history.pushState(null, '', path)
          }
        }
        router(ctx, page)
      }
    })
  })


  let prev: string | undefined
  let parse = (path: string): Page<Config, keyof Config> | false | undefined => {
    if (!opts.search) path = path.split('?')[0]
    path = path.replace(/\/($|\?)/, '$1') || '/'
    if (prev === path) return false
    prev = path

    for (let [route, pattern, cb] of router.routes) {
      let match = path.match(pattern)
      if (match) {
        return { path, route, params: cb(...match.slice(1)) }
      }
    }
    return undefined
  }

  let click = (event: MouseEvent): void => {
    let target = event.target as HTMLElement
    let link = target.closest('a')
    if (
      link &&
      !event.defaultPrevented &&
      event.button === 0 &&
      link.target !== '_blank' &&
      link.dataset.noRouter == null &&
      link.rel !== 'external' &&
      !link.download &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      let url = new URL(link.href)
      if (url.origin === location.origin) {
        event.preventDefault()
        let changed = location.hash !== url.hash
        router.open(url.pathname + url.search)
        if (changed) {
          location.hash = url.hash
          if (url.hash === '' || url.hash === '#') {
            window.dispatchEvent(new HashChangeEvent('hashchange'))
          }
        }
      }
    }
  }

  let popstate = action((ctx): void => {
    let page = parse(location.pathname + location.search)
    if (page !== false) router(ctx, page)
  })

  if (typeof window !== 'undefined' && typeof location !== 'undefined') {
    onConnect(router, (ctx) => {
      let page = parse(location.pathname + location.search)
      if (page !== false) router(ctx, page)
      if (opts.links !== false) document.body.addEventListener('click', click)
      let handlePopstate = (): void => {
        popstate(ctx)
      }
      window.addEventListener('popstate', handlePopstate)
      return () => {
        prev = undefined
        document.body.removeEventListener('click', click)
        window.removeEventListener('popstate', handlePopstate)
      }
    })
  } else {
    // router(ctx, parse('/'))
  }

  return router
}

/**
 * Generates pathname by name and parameters. Useful to render links.
 *
 * ```js
 * import { getPageUrl } from 'nanostores'
 *
 * getPageUrl(router, 'post', { categoryId: 'guides', id: '10' })
 * //=> '/posts/guides/10'
 * ```
 *
 * @param router Router.
 * @param name Route name.
 * @param params Route parameters.
 */
export function getPagePath<
  Config extends RouterConfig,
  PageName extends keyof Config
>(
  router: Router<Config>,
  name: PageName,
  ...params: ParamsArg<Config, PageName>[]
): string {
  let route = router.routes.find(i => i[0] === name)
  if (process.env.NODE_ENV !== 'production') {
    if (!route?.[3]) throw new Error('RegExp routes are not supported')
  }
  let path = route?.[3]
    ?.replace(/\/:\w+\?/g, i => {
      let param = params[i.slice(2).slice(0, -1)]
      if (param) {
        return '/' + encodeURIComponent(param)
      } else {
        return ''
      }
    })
    .replace(/\/:\w+/g, i => '/' + encodeURIComponent(params[i.slice(2)]))
  return path || '/'
}

/**
 * Open page by name and parameters. Pushes new state into history.
 *
 * ```js
 * import { openPage } from 'nanostores'
 *
 * openPage(router, 'post', { categoryId: 'guides', id: '10' })
 * ```
 *
 * @param router Router instance.
 * @param name Route name.
 * @param params Route parameters.
 */
export function openPage<
  Config extends RouterConfig,
  PageName extends keyof Config
>(
  router: Router<Config>,
  name: PageName,
  ...params: ParamsArg<Config, PageName>[]
): void {
  router.open(getPagePath(router, name, ...params))
}

/**
 * Open page by name and parameters. Replaces recent state in history.
 *
 * ```js
 * import { redirectPage } from '@logux/state'
 *
 * openPage(router, 'login')
 * // replace login route, so we don't face it on back navigation
 * redirectPage(router, 'post', { categoryId: 'guides', id: '10' })
 * ```
 *
 * @param router Router instance.
 * @param name Route name.
 * @param params Route parameters.
 */
export function redirectPage<
  Config extends RouterConfig,
  PageName extends keyof Config
>(
  router: Router<Config>,
  name: PageName,
  ...params: ParamsArg<Config, PageName>[]
): void {
  router.open(getPagePath(router, name, ...params), true)
}

interface SearchParamsOptions {
  links?: boolean
}

/**
 * Store to watch for `?search` URL part changes.
 *
 * It will track history API and clicks on page’s links.
 */
interface SearchParamsStore
  extends AtomMut<Record<string, string>> {
  /**
   * Change `?search` URL part and update store value.
   *
   * ```js
   * searchParams.open({ sort: 'name', type: 'small' })
   * ```
   *
   * @param params Absolute URL (`https://example.com/a`)
   *             or domain-less URL (`/a`).
   * @param redirect Don’t add entry to the navigation history.
   */
  open(params: Record<string, string>, redirect?: boolean): void
}

export function createSearchParams(opts: SearchParamsOptions = {}): SearchParamsStore {
  let store: SearchParamsStore = Object.assign(atom({}), {
    open: action((ctx, params: Record<string, string>, redirect?: boolean) => {
      let search = new URLSearchParams(params).toString()
      if (search) search = '?' + search

      if (prev === search) return
      prev = search

      if (typeof history !== 'undefined') {
        let href = location.pathname + search + location.hash
        if (typeof history !== 'undefined') {
          if (redirect) {
            history.replaceState(null, '', href)
          } else {
            history.pushState(null, '', href)
          }
        }
      }
      store(ctx, params)
    })
  })

  let prev: string | undefined
  let update = action((ctx, href: string): false | void => {
    let url = new URL(href)
    if (prev === url.search) return false
    prev = url.search
    store(ctx, Object.fromEntries(url.searchParams))
  })

  let click = action((ctx, event: MouseEvent): void => {
    let target = event.target as HTMLElement
    let link = target.closest('a')
    if (
      link &&
      event.button === 0 &&
      link.target !== '_blank' &&
      link.dataset.noRouter == null &&
      link.rel !== 'external' &&
      !link.download &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      let url = new URL(link.href)
      if (url.origin === location.origin) {
        if (url.search !== prev) {
          prev = url.search
          store(ctx, Object.fromEntries(url.searchParams))
        }
        if (url.pathname === location.pathname && url.hash === location.hash) {
          event.preventDefault()
          history.pushState(null, '', link.href)
        }
      }
    }
  })

  let popstate = action((ctx): void => {
    update(ctx, location.href)
  })

  if (typeof window !== 'undefined' && typeof location !== 'undefined') {
    onConnect(store, (ctx) => {
      popstate(ctx)
      let handleClick = (event: MouseEvent): void => {
        click(ctx, event)
      }
      let handlePopstate = (): void => {
        popstate(ctx)
      }
      if (opts.links !== false) document.body.addEventListener('click', handleClick)
      window.addEventListener('popstate', handlePopstate)
      return () => {
        document.body.removeEventListener('click', handleClick)
        window.removeEventListener('popstate', handlePopstate)
      }
    })
  }

  return store
}
