import fs from 'fs'
import mkdirp from 'mkdirp'
import each from 'lodash/each'
import partial from 'lodash/partial'
import some from 'lodash/some'
import reject from 'lodash/reject'
import assign from 'lodash/assign'
import {parallel} from 'async'
import request from 'request'
import urlUtils from 'url'
import debug from './debug'
import urlToPath from './urlToPath'

const debugApi = debug('api')
const debugJson = debug('json')
const debugMedia = debug('media')

const stripUrlParts = (url, ...rejects) => {
  const rejector = (part) => some(rejects, (r) => part.match(r))
  const parsed = urlUtils.parse(url)
  const newUrl = urlUtils.format(assign(parsed, {
    pathname: reject(parsed.pathname.split('/'), rejector).join('/')
  }))
  return url !== newUrl ? newUrl : null
}

const shouldWrite = ({debug, filepath, overwrite}, no, yes) => {
  fs.exists(filepath, (exists) => {
    if (exists && !overwrite) {
      debug(`Exists, skipping ${filepath}`)
      no()
    } else if (exists && overwrite) {
      debug(`Exists, overwriting ${filepath}`)
      yes()
    } else {
      debug(`Does not exist, writing ${filepath}`)
      yes()
    }
  })
}

export const saveJson = ({ig, jsonDir, refresh, full}) => (json, saveDone) => {
  const id = json.id
  const filepath = jsonDir(`${id}.json`)

  const writeIfNeeded = partial(shouldWrite, {debug: debugJson, filepath, overwrite: refresh}, saveDone)
  const writeFile = (data) => fs.writeFile(filepath, JSON.stringify(data), {encoding: 'utf8'}, saveDone)

  const fetchForPost = (fetch) => (cb) => ig[fetch](id, (err, res, remaining) => {
    debugApi(`API calls left ${remaining}`)
    if (err) {
      debugApi(`${fetch} API error ${err}`)
      return cb(err)
    }
    debugJson(`${id} ${fetch} ${res.length}`)
    cb(null, res)
  })

  writeIfNeeded(() => {
    if (full) {
      // Full means we fetch likes and comments separately and add those
      // to the json payload that gets saved
      parallel({
        likes: fetchForPost('likes'),
        comments: fetchForPost('comments')
      }, (err, {likes, comments}) => {
        if (err) return saveDone(err)
        json.likes.data = likes
        json.comments.data = comments
        writeFile(json)
      })
    } else {
      writeFile(json)
    }
  })
}

export const saveMedia = ({mediaDir}) => (url, saveDone) => {
  // The Instagram media files get saved to a location on disk that matches the
  // urls domain+path, so we need to make that directory and then save the file
  const {filepath, dirname} = urlToPath({mediaDir, url})

  // An Instagram media at a url should never change so we shouldn't ever
  // need to download it more than once
  const writeIfNeeded = partial(shouldWrite, {debug: debugMedia, filepath, overwrite: false}, saveDone)

  writeIfNeeded(() => {
    mkdirp(dirname, (err) => {
      if (err) {
        debugMedia(`Error creating dir ${dirname}: ${err}`)
        return saveDone(err)
      }
      request(url)
      .on('error', (err) => {
        debugMedia(`Error fetching media ${url}: ${err}`)
        saveDone(err)
      })
      .pipe(fs.createWriteStream(filepath))
      .on('close', saveDone)
    })
  })
}

export const fetchAndSave = ({jsonQueue, mediaQueue}, cb) => {
  let COUNT = 0

  // The callback passed to the function will be executed once
  // both json and media queues have been drained
  const onDrain = () => {
    if (mediaQueue.running() === 0 && jsonQueue.running() === 0) {
      cb()
    }
  }

  jsonQueue.drain = () => {
    debugJson('queue drain')
    onDrain()
  }

  mediaQueue.drain = () => {
    debugMedia('queue drain')
    onDrain()
  }

  const fetchMedia = (err, medias, pagination, remaining) => {
    debugApi(`API calls left ${remaining}`)

    if (err) {
      if (err.error_type === 'APINotAllowedError') {
        debugApi('Its possible the user\'s account you are trying to download is private')
      }
      debugApi(`API error ${err}`)
    } else if (medias && medias.length) {
      COUNT += medias.length
      debugApi(`Fetched media ${medias.length}`)
      debugApi(`Fetched total ${COUNT}`)
      medias.forEach((media) => {
        // Special stuff for https://github.com/lukekarrys/instagram-download/issues/3
        if (media.images) {
          const {thumbnail, standard_resolution} = media.images
          if (thumbnail) {
            // high res uncropped
            // remove s150x150 and c0.134.1080.1080 from
            // t51.2885-15/s150x150/e35/c0.134.1080.1080/12725175_958336534244864_1369827234_n.jpg
            const highRes = stripUrlParts(thumbnail.url, /^s\d+x\d+$/, /^c\d+\.\d+\.\d+\.\d+$/)
            if (highRes) media.images.high_resolution = { url: highRes }
          }
          // high res cropped
          // remove s640x640 from
          // t51.2885-15/s640x640/sh0.08/e35/12502019_964211777003492_661892888_n.jpg
          if (standard_resolution) {
            const highResCropped = stripUrlParts(standard_resolution.url, /^s\d+x\d+$/)
            if (highResCropped) media.images.high_resolution_cropped = { url: highResCropped }
          }
        }
        jsonQueue.push(media)
        each(media.images, (img) => mediaQueue.push(img.url))
        each(media.videos, (video) => mediaQueue.push(video.url))
      })
    } else if (medias.length === 0 && COUNT === 0 && !pagination.next) {
      debugApi('No media')
      cb()
    }

    if (pagination) {
      debugApi(`Has next page ${!!pagination.next}`)
      pagination.next && pagination.next(fetchMedia)
    }
  }

  return fetchMedia
}
