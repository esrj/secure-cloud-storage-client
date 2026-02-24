/**
 * This compoment is a table for showing user's files
 */
import { Typography } from '@material-tailwind/react'
import { FolderIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import FileOptionMenu from './FileOptionMenu'
import TableView from './TableView'
import { useContext, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { PermissionType, bytesToSize, searchFilter } from './Types'
import { CurPathContext, SearchContext } from './Contexts'

const TABLE_HEAD = ['icon', 'name', 'size', 'date', 'perm', 'end']

function FileTable({ fileList, folderList }) {
  const { curPath, setCurPath } = useContext(CurPathContext)
  const [tableContent, setTableContent] = useState([])
  const [folderContent, setFolderContent] = useState([])
  const {
    searchTypeC: [searchType],
    searchTermC: [searchTerm]
  } = useContext(SearchContext)

  useEffect(() => {
    setTableContent(searchFilter(fileList, searchType, searchTerm))
    setFolderContent(searchFilter(folderList, searchType, searchTerm))
  }, [searchTerm, searchType, fileList, folderList])

  return (
    <TableView tableHead={TABLE_HEAD}>
      {folderContent.map((row) => (
        <tr
          key={row.folderId}
          onDoubleClick={() => setCurPath([...curPath, { name: row.name, folderId: row.folderId }])}
          className="border-t"
        >
          <td>
            <FolderIcon className="size-5" />
          </td>
          <td>
            <Typography className="truncate pr-4">{row.name}</Typography>
          </td>
          <td>
            <Typography>--</Typography>
          </td>
          <td>
            <Typography>--</Typography>
          </td>
          <td>
            <Typography>--</Typography>
          </td>
          <td>
            <FileOptionMenu fileData={row} haveDelete isFolder />
          </td>
        </tr>
      ))}
      {tableContent.map((row) => (
        <tr key={row.fileId} className="border-t">
          <td>
            <DocumentTextIcon className="size-5" />
          </td>
          <td>
            <Typography className="truncate pr-4">{row.name}</Typography>
          </td>
          <td>
            <Typography>{bytesToSize(row.size)}</Typography>
          </td>
          <td>
            <Typography>{row.date}</Typography>
          </td>
          <td>
            <Typography>{PermissionType[row.perm]}</Typography>
          </td>
          <td>
            <FileOptionMenu fileData={row} haveDetail haveDelete haveDownload haveMove />
          </td>
        </tr>
      ))}
    </TableView>
  )
}

FileTable.propTypes = {
  fileList: PropTypes.array.isRequired,
  folderList: PropTypes.array.isRequired
}

export default FileTable
