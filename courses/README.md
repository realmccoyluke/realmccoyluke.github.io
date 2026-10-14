# Shared courses

Courses in this folder are published to everyone using the app. To add one:

1. Create a JSON file in this folder, such as `spring-invitational.json`.
2. Give it a course name and an ordered list of latitude/longitude points:

   ```json
   {
     "name": "Spring Invitational",
     "points": [
       [42.1234, -71.2345],
       [42.1241, -71.2328],
       [42.1253, -71.2332]
     ]
   }
   ```

   Include at least two points. Coordinates must be decimal degrees, with
   latitude first and longitude second.

3. Add the JSON filename to the `courses` array in [`index.json`](./index.json):

   ```json
   {
     "format": "pacepath-public-courses",
     "version": 1,
     "courses": [
       { "file": "spring-invitational.json" }
     ]
   }
   ```

Commit and publish both files. The course will then appear under **Shared
courses** in **Choose course** for everyone. Users can select shared courses,
but saving or importing courses in the app remains private to their browser.
