/**
 * This file create and store the contexts
 */
import { createContext } from 'react'

export const ProfileContext = createContext({
  storedNameC: ['', null],
  storedEmailC: ['', null],
  userIdC: ['', null],
  login: null,
  loggedIn: false
})
export const PageContext = createContext(['', null])
export const SearchContext = createContext({
  searchTypeC: ['', null],
  searchTermC: ['', null],
  publicSearchTermC: ['', null],
  searchTimesC: [0, null]
})
export const CurPathContext = createContext([[], null])
export const RequestContext = createContext({
  requestListC: [[], null],
  requestedListC: [[], null]
})
export const UserListContext = createContext({
  whiteListC: [[], null],
  blackListC: [[], null]
})
export const GlobalAttrsContext = createContext({
  globalAttrs: []
})
