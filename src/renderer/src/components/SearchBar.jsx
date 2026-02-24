/**
 * This component is a search bar, used for searching from server (public) or filtering files (file, reply, request)
 */
import { Button, Menu, MenuHandler, MenuList, MenuItem, Input } from '@material-tailwind/react'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useContext } from 'react'
import { PageContext, SearchContext } from './Contexts'
import { PageType, SearchType } from './Types'
import { Validators } from './Validator'

function SearchBar() {
  const {
    searchTypeC: [type, setType],
    searchTermC: [searchTerm, setSearchTerm],
    publicSearchTermC: [publicSearchTerm, setPublicSearchTerm],
    searchTimesC: [searchTimes, setSearchTimes]
  } = useContext(SearchContext)
  const [pageType] = useContext(PageContext)

  return (
    <div className="flex flex-row grow justify-center items-center">
      <Menu placement="bottom-start">
        <MenuHandler>
          <Button
            ripple={false}
            variant="text"
            className="rounded-r-none h-full min-w-24 !px-0 justify-center border border-gray-400"
          >
            {pageType === PageType.public ? 'Tag' : type}
          </Button>
        </MenuHandler>
        {pageType !== PageType.public && (
          <MenuList>
            {Object.entries(SearchType).map(([key, value]) => (
              <MenuItem key={key} onClick={() => setType(value)} className="bg-white items-center">
                {value}
              </MenuItem>
            ))}
          </MenuList>
        )}
      </Menu>
      <Input
        label={pageType === PageType.public ? '輸入標籤搜尋，以空格隔開' : '搜尋'}
        labelProps={{ className: 'font-sans peer-focus:hidden' }}
        value={pageType === PageType.public ? publicSearchTerm : searchTerm}
        error={
          pageType === PageType.public
            ? !Validators.tags(publicSearchTerm).valid
            : !Validators.search(searchTerm).valid
        }
        onChange={(e) => {
          if (pageType === PageType.public) setPublicSearchTerm(e.target.value)
          else setSearchTerm(e.target.value)
        }}
        size="lg"
        className="grow rounded-none focus:!border-t-gray-900"
      ></Input>
      <Button
        className="h-full min-w-12 rounded-l-none justify-center"
        size="sm"
        variant="gradient"
        onClick={() => setSearchTimes(searchTimes + 1)}
      >
        <MagnifyingGlassIcon className="size-4" />
      </Button>
    </div>
  )
}

export default SearchBar
