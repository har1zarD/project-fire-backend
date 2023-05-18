import { RequestHandler } from "express";
import createHttpError from "http-errors";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import fs from "fs";
import handlebars from "handlebars";
import path from "path";

import env from "../utils/validate-env";
import * as UsersInterfaces from "../interfaces/users";
import { UserModel, UserRole } from "../models/user";
import { EmployeeModel } from "../models/employee";
import { TokenModel } from "../models/token";
import { ProjectModel } from "../models/project";

export const getUsers: RequestHandler<unknown, UsersInterfaces.GetUsersRes[], unknown, unknown> = async (
  req,
  res,
  next
) => {
  try {
    const users = await UserModel.find().populate("employee").select("-password");

    const usersResponse = users.map((user) => ({
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      image: user.image,
      employee: user.employee,
    }));

    return res.status(200).json(usersResponse);
  } catch (error) {
    next(error);
  }
};

export const getUserById: RequestHandler<
  UsersInterfaces.GetUserByIdParams,
  UsersInterfaces.GetUserByIdRes,
  unknown,
  unknown
> = async (req, res, next) => {
  try {
    const userId = req.params.userId;

    const user = await UserModel.findById(userId).populate("employee").select("-password");
    if (!user) throw createHttpError(404, "User not found.");

    const userResponse = {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      image: user.image,
      employee: user.employee,
    };

    return res.status(200).json(userResponse);
  } catch (error) {
    next(error);
  }
};

export const registerUser: RequestHandler<
  unknown,
  UsersInterfaces.RegisterUserRes,
  UsersInterfaces.RegisterUserReq,
  unknown
> = async (req, res, next) => {
  const { email, password, firstName, lastName, role, department, salary, techStack } = req.body;

  let user;
  let employee;

  try {
    if (!email || !password || !firstName || !lastName) throw createHttpError(400, "Missing required fields.");

    const existingUser = await UserModel.findOne({ email });
    if (existingUser) throw createHttpError(409, "Email already registered.");

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    let imageData: string | undefined = undefined;
    if (req.file) {
      const buffer = await fs.promises.readFile(req.file.path);
      const fileType = req.file.mimetype.split("/")[1];
      const base64EncodedData = buffer.toString("base64");
      imageData = `data:image/${fileType};base64,${base64EncodedData}`;
      await fs.promises.unlink(req.file.path);
    }

    employee = await EmployeeModel.create({
      firstName,
      lastName,
      department,
      salary,
      techStack,
    });

    user = await UserModel.create({
      email,
      password: hashedPassword,
      firstName,
      lastName,
      role,
      image: imageData,
      employee: employee._id,
    });

    // 1d in milliseconds
    const expireLength = 1000 * 60 * 60 * 24;
    const token = jwt.sign({ userId: user._id }, env.JWT_SECRET, {
      expiresIn: expireLength,
    });

    return res.status(201).json({
      user: {
        id: user._id,
        email,
        firstName,
        lastName,
        role: user.role,
        image: imageData,
        employee: {
          id: employee._id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          department: employee.department,
          salary: employee.salary,
          techStack: employee.techStack,
        },
      },
      token,
      expiresIn: expireLength,
    });
  } catch (error) {
    if (employee && !user) {
      await employee.deleteOne();
    }
    next(error);
  }
};

export const loginUser: RequestHandler<
  unknown,
  UsersInterfaces.LoginUserRes,
  UsersInterfaces.LoginUserReq,
  unknown
> = async (req, res, next) => {
  const { email, password, rememberMe } = req.body;

  try {
    if (!email || !password) throw createHttpError(400, "Missing required fields.");

    const user = await UserModel.findOne({ email }).populate("employee");
    if (!user) throw createHttpError(401, "Invalid email or password.");

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) throw createHttpError(401, "Invalid email or password.");

    // Either 7d in milliseconds, or 1d in milliseconds
    const expireLength = rememberMe ? 1000 * 60 * 60 * 24 * 7 : 1000 * 60 * 60 * 24;
    const token = jwt.sign({ userId: user._id }, env.JWT_SECRET, {
      expiresIn: expireLength,
    });

    return res.status(200).json({
      user: {
        id: user._id,
        email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        image: user.image,
        employee: user.employee,
      },
      token,
      expiresIn: expireLength,
    });
  } catch (error) {
    next(error);
  }
};

export const sendResetPasswordEmail: RequestHandler<
  unknown,
  unknown,
  UsersInterfaces.sendResetPasswordEmailReq,
  unknown
> = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) throw createHttpError(400, "Email not provided.");

    const user = await UserModel.findOne({ email });
    if (!user) throw createHttpError(404, "User not found.");

    let tokenObj = await TokenModel.findOne({ user: user._id });
    if (!tokenObj) {
      const expireLength = 60 * 60 * 1000;

      tokenObj = await TokenModel.create({
        user: user._id,
        token: jwt.sign({ userId: user._id }, env.JWT_SECRET, {
          expiresIn: expireLength,
        }),
        expirationTime: new Date(Date.now() + expireLength),
      });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: env.EMAIL_ADDRESS,
        pass: env.EMAIL_PASSWORD,
      },
    });

    const template = handlebars.compile(
      fs.readFileSync(path.join(__dirname, "../../public/views/resetpassword.hbs"), "utf8")
    );

    const htmlToSend = template({ resetLink: `${env.CLIENT_URL}/${tokenObj.user}/reset-password/${tokenObj.token}/` });

    const mailOptions = {
      from: env.EMAIL_ADDRESS,
      to: email,
      subject: "Password Reset Request",
      html: htmlToSend,
    };

    transporter.sendMail(mailOptions);

    res.status(200).json({ message: "An email has been sent to reset your password." });
  } catch (error) {
    next(error);
  }
};

export const resetPassword: RequestHandler<
  UsersInterfaces.resetPasswordParams,
  unknown,
  UsersInterfaces.resetPasswordReq,
  unknown
> = async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const token = req.params.token;
    const { password } = req.body;

    const user = await UserModel.findById(userId);
    if (!user) throw createHttpError(400, "Link is invalid or has expired.");

    const tokenObj = await TokenModel.findOne({
      user: user._id,
      token: token,
    });
    if (!tokenObj) throw createHttpError(400, "Link is invalid or has expired.");

    if (!password) throw createHttpError(400, "Password not provided.");

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    user.password = hashedPassword;

    await user.save();
    await tokenObj.deleteOne();

    res.send({ message: "Your password has been reset successfully." });
  } catch (error) {
    next(error);
  }
};

export const deleteUser: RequestHandler<
  UsersInterfaces.DeleteUserParams,
  unknown,
  UsersInterfaces.DeleteUserReq,
  unknown
> = async (req, res, next) => {
  try {
    const userId = req.params.userId;

    const user = await UserModel.findById(userId);
    if (!user) throw createHttpError(404, "User not found.");
    if (user.role === UserRole.Admin) throw createHttpError(403, "Cannot delete an admin user.");

    if (req.body.userId === userId) throw createHttpError(403, "You are not authorized to delete yourself.");

    const employee = await EmployeeModel.findById(user.employee);
    if (!employee) throw createHttpError(404, "Employee not found.");

    const projects = await ProjectModel.find({ "employees.employee": employee._id });
    for (const project of projects) {
      project.employees = project.employees.filter(
        (employeeObj) => employeeObj.employee.toString() !== employee._id.toString()
      );
      await project.save();
    }

    await user.deleteOne();
    await employee.deleteOne();

    return res.status(200).json({ message: "User deleted successfully." });
  } catch (error) {
    next(error);
  }
};
