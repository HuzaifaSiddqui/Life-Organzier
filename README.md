# Life-Organzier
An AI Life Organizer


git checkout Staging-LifeOrganizer
git pull origin Staging-LifeOrganizer


git add .
git commit -m "feature update"
git push


cd "/Users/huzaifasiddiqui/Desktop/Huzaifa/6 Semester/FYP/Life-Organzier-1/mobile"
npx expo start -c

cd backend
npm run dev


npx expo prebuild --clean
npx expo run:android

cd backend
npx prisma studio